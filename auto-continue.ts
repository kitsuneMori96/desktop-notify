import type { Plugin } from "@opencode-ai/plugin"

const SENTINEL = "[auto-continue]"
const SELF_ECHO_WINDOW_MS = 15_000
const MAX_FUSE = 10
const EPISODE_RESET_MS = 30 * 60_000
const DEBOUNCE_MS = 2_500
const BASE_COOLDOWN_MS = 20_000
const COOLDOWN_CAP_MS = 180_000
const NUDGE_COOLDOWN_MS = 60_000
const MAX_NUDGES = 3
const ABORT_BLACKOUT_MS = 15_000
const MIN_PROGRESS_TOKENS = 40
const DEFER_LIMIT = 2

type SState = {
  fuse: number
  nudges: number
  noProgress: number
  lastInjectAt: number
  abortUntil: number
  timer: ReturnType<typeof setTimeout> | null
}

export default (async ({ client }) => {
  const states = new Map<string, SState>()
  void client.app.log({
    body: { service: "auto-continue", level: "info", message: "auto-continue plugin loaded" },
  })

  const stateOf = (id: string): SState => {
    let s = states.get(id)
    if (!s) {
      s = { fuse: 0, nudges: 0, noProgress: 0, lastInjectAt: 0, abortUntil: 0, timer: null }
      states.set(id, s)
    }
    return s
  }

  const cancelTimer = (id: string) => {
    const s = states.get(id)
    if (s?.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
  }

  const log = async (level: "debug" | "info" | "warn" | "error", message: string, id?: string) => {
    try {
      const prefix = id ? `[${id.slice(0, 8)}] ` : ""
      await client.app.log({ body: { service: "auto-continue", level, message: prefix + message } })
    } catch {}
  }

  const maybeEpisodeReset = (s: SState) => {
    if (s.lastInjectAt > 0 && Date.now() - s.lastInjectAt > EPISODE_RESET_MS) {
      s.fuse = 0
      s.nudges = 0
      s.noProgress = 0
    }
  }

  const schedule = (id: string, attempt: number, delay: number) => {
    if (attempt > DEFER_LIMIT) return
    cancelTimer(id)
    const s = stateOf(id)
    s.timer = setTimeout(() => void check(id, attempt), delay)
  }

  const inject = async (id: string, text: string) => {
    await client.session.promptAsync({
      path: { id },
      body: { parts: [{ type: "text", text }] },
    })
  }

  const analyzeParts = (parts: any[]) => {
    const textParts = parts.filter((p) => p?.type === "text" && !p.synthetic)
    const fullText = textParts.map((p) => String(p.text ?? "")).join("\n")
    const trimmedEnd = fullText.trimEnd()
    const fenceCount = (fullText.match(/```/g) ?? []).length
    const fenceOdd = fenceCount % 2 === 1
    const dangling =
      /[：:，、；;（(【「『]$|\[[^\]]*$|\([^)]*$|[-*+>|]$/.test(trimmedEnd) ||
      /\[[^\]]*\]\([^)]*$/.test(trimmedEnd)
    const lastPart = parts[parts.length - 1]
    const lastType = String(lastPart?.type ?? "")
    const toolPending = parts.some(
      (p) => p?.type === "tool" && ["pending", "running"].includes(p?.state?.status),
    )
    const questionAsked = parts.some((p) => p?.type === "tool" && p?.tool === "question")
    const hasContent = textParts.length > 0 || parts.some((p) => p?.type === "tool")
    return { trimmedEnd, fenceOdd, dangling, lastType, toolPending, questionAsked, hasContent }
  }

  const check = async (id: string, attempt: number) => {
    const s = stateOf(id)
    s.timer = null
    maybeEpisodeReset(s)
    if (Date.now() < s.abortUntil) return
    try {
      const sess = await client.session.get({ path: { id } })
      if ((sess.data as any)?.parentID) return

      const res = await client.session.messages({ path: { id }, query: { limit: 8 } })
      const msgs = (res.data ?? []) as any[]
      let entry: any
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.info?.role === "assistant") {
          entry = msgs[i]
          break
        }
      }
      if (!entry) return
      if (entry.info.error) {
        await log("info", `assistant 消息带错误标记 ${String(entry.info.error?.name)}，不干预`, id)
        return
      }

      const parts = (entry.parts ?? []) as any[]
      const a = analyzeParts(parts)

      if (a.questionAsked) {
        await log("debug", "在等待用户回答问题，不干预", id)
        return
      }

      const truncated =
        !a.hasContent ||
        a.fenceOdd ||
        a.dangling ||
        ["reasoning", "step-start", "retry"].includes(a.lastType) ||
        a.toolPending

      if (truncated) {
        if (s.fuse >= MAX_FUSE) {
          await log("warn", `熔断：本故障期已注入 ${MAX_FUSE} 次，停止自动续写（真实用户消息或闲置30分钟后重置）`, id)
          return
        }
        const outputTokens = Number(entry.info?.tokens?.output ?? 0)
        s.noProgress = outputTokens < MIN_PROGRESS_TOKENS ? s.noProgress + 1 : 0
        const cooldown = Math.min(BASE_COOLDOWN_MS * 2 ** s.noProgress, COOLDOWN_CAP_MS)
        const since = Date.now() - s.lastInjectAt
        if (since < cooldown) {
          schedule(id, attempt + 1, cooldown - since + 500)
          return
        }
        await inject(id, "继续")
        s.fuse += 1
        s.lastInjectAt = Date.now()
        await log(
          "info",
          `检测到截断（尾字符="${a.trimmedEnd.slice(-1)}" fenceOdd=${a.fenceOdd} last=${a.lastType}）→ 已自动续写 ${s.fuse}/${MAX_FUSE}${s.noProgress > 0 ? `（无进展退避 x${s.noProgress}）` : ""}`,
          id,
        )
        return
      }

      const todoRes = await client.session.todo({ path: { id } }).catch(() => ({ data: [] }))
      const todos = (todoRes.data ?? []) as any[]
      const open = todos.filter((t) => t.status === "pending" || t.status === "in_progress")

      if (todos.length > 0 && open.length > 0) {
        if (s.nudges >= MAX_NUDGES) {
          await log("warn", `催单已达上限 ${MAX_NUDGES} 次仍有未完成任务，停止自动催促`, id)
          return
        }
        const since = Date.now() - s.lastInjectAt
        if (since < NUDGE_COOLDOWN_MS) {
          schedule(id, attempt + 1, NUDGE_COOLDOWN_MS - since + 500)
          return
        }
        const list = open
          .slice(0, 5)
          .map((t) => `- [${t.status}] ${t.content}`)
          .join("\n")
        await inject(
          id,
          `${SENTINEL} 会话空闲但以下任务尚未完成：\n${list}\n请继续完成这些任务。`,
        )
        s.nudges += 1
        s.fuse += 1
        s.lastInjectAt = Date.now()
        await log("info", `收尾完整但 todo 未清空 → 催单 ${s.nudges}/${MAX_NUDGES}`, id)
        return
      }

      await log("debug", "判定任务已完成，不干预", id)
    } catch (e) {
      await log("error", `检查失败：${e instanceof Error ? e.message : String(e)}`, id)
    }
  }

  const handleUserMessage = async (id: string, messageID: string) => {
    const s = stateOf(id)
    cancelTimer(id)
    try {
      const res = await client.session.messages({ path: { id }, query: { limit: 4 } })
      const msgs = (res.data ?? []) as any[]
      const target = msgs.find((m) => m.info?.id === messageID)
      if (!target) return
      const text = ((target.parts ?? []) as any[])
        .filter((p) => p?.type === "text" && !p.synthetic)
        .map((p) => String(p.text ?? ""))
        .join("\n")
      if (text.includes(SENTINEL)) return
      if (
        Date.now() - s.lastInjectAt < SELF_ECHO_WINDOW_MS &&
        /^继续[。.!！]?$/.test(text.trim())
      )
        return
      s.fuse = 0
      s.nudges = 0
      s.noProgress = 0
      await log("debug", "真实用户消息 → 熔断计数重置", id)
    } catch {}
  }

  return {
    event: async (input: unknown) => {
      const ev = (input as any)?.event
      if (!ev?.type) return
      const props = ev.properties ?? {}
      switch (ev.type as string) {
        case "session.idle": {
          const id = props.sessionID
          if (id) schedule(id, 0, DEBOUNCE_MS)
          break
        }
        case "message.updated": {
          const id = props.sessionID
          if (!id) break
          cancelTimer(id)
          if (props.info?.role === "user") void handleUserMessage(id, props.info.id)
          break
        }
        case "session.status":
        case "message.part.updated": {
          if (props.sessionID) cancelTimer(props.sessionID)
          break
        }
        case "session.error": {
          const id = props.sessionID
          if (!id) break
          cancelTimer(id)
          const name = String(props.error?.name ?? "")
          if (/abort/i.test(name)) stateOf(id).abortUntil = Date.now() + ABORT_BLACKOUT_MS
          break
        }
        case "session.deleted": {
          const id = props.sessionID ?? props.info?.id
          if (id) {
            cancelTimer(id)
            states.delete(id)
          }
          break
        }
      }
    },
  }
}) satisfies Plugin
