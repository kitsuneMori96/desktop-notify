import { Plugin } from "@opencode/plugin"
import { writeFile, appendFile } from "node:fs/promises"

const DEBUG = !!process.env.DESKTOP_NOTIFY_DEBUG
const DEBUG_FILE = "/tmp/opencode/desktop-notify-debug.log"
const debugLog = (msg: string) => {
  if (!DEBUG) return
  void appendFile(DEBUG_FILE, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`).catch(() => {})
}

// 常开轻量轨迹：插件静默失效时唯一可用的证据。只在关键节点写，量很小。
const TRACE_FILE = "/tmp/opencode/desktop-notify-trace.log"
const trace = (msg: string) => {
  void appendFile(TRACE_FILE, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`).catch(() => {})
}

const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
const PROTOCOL = "opencode-focus"
const MIN_INTERVAL_MS = 400
const SOUND_GAP_MS = 1500
const SPAWN_TIMEOUT_MS = 15_000
const ERROR_SUPPRESS_MS = 10_000
const IDLE_DEBOUNCE_MS = 2500

type Kind = "info" | "ask" | "error"

const SOUND_FILES: Record<Kind, string[]> = {
  info: ["Windows Notify System Generic.wav", "Windows Notify.wav", "notify.wav"],
  ask: ["Windows Notify Messaging.wav", "Windows Exclamation.wav", "chord.wav"],
  error: ["Windows Error.wav", "Windows Critical Stop.wav", "ding.wav"],
}

const SYSTEM_SOUND: Record<Kind, string> = { info: "Asterisk", ask: "Exclamation", error: "Hand" }

const FOCUS_PS1 = `param([string]$u = "")
$ErrorActionPreference = "SilentlyContinue"
$idx = $u.IndexOf("?")
$b = if ($idx -ge 0) { $u.Substring($idx + 1) } else { $u }
$b = $b.Replace("-", "+").Replace("_", "/")
switch ($b.Length % 4) { 2 { $b += "==" } 3 { $b += "=" } }
$kws = @()
try { $kws = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))) -split [char]10 | Where-Object { $_ } } catch {}
if ($kws.Count -eq 0) { $kws = @("opencode") }

$src = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public class Info { public IntPtr H; public string T; public uint P; }
  public static List<Info> List() {
    var r = new List<Info>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      if (GetWindowText(h, sb, 512) <= 0) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      r.Add(new Info { H = h, T = sb.ToString(), P = p });
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
Add-Type -TypeDefinition $src

$names = @{}
Get-Process | ForEach-Object { $names[[uint32]$_.Id] = $_.ProcessName }

$all = [FW]::List()
$termNames = "WindowsTerminal|ConEmu|WezTerm|Hyper|Alacritty|wt"
$cand = @($all | Where-Object { $n = $names[$_.P]; ($n -match $termNames) -or ($_.T -match "opencode|ubuntu|wsl|bash|zsh|powershell|cmd|terminal") })

$best = $null
foreach ($kw in $kws) {
  foreach ($w in $cand) {
    if ($w.T.IndexOf($kw, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $best = $w; break }
  }
  if ($best) { break }
}
if (-not $best -and $cand.Count -ge 1) { $best = $cand[0] }

if ($best) {
  $h = $best.H
  [void][FW]::ShowWindow($h, 9)
  [void][FW]::SetForegroundWindow($h)
  try { (New-Object -ComObject WScript.Shell).AppActivate([int]$best.P) | Out-Null } catch {}
}
`

const escXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")

const oneLine = (s: unknown, max = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max)

const pickText = (v: any): string => {
  if (typeof v === "string") return v
  if (Array.isArray(v)) return v.map(pickText).join(" ")
  if (v && typeof v === "object") return Object.values(v).map(pickText).join(" ")
  return ""
}

const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const baseTag = (dir: unknown) => String(dir || "").split("/").filter(Boolean).pop() ?? ""

// ---- 共享运行时（V1 server() 与 V2 setup() 共用，同一进程只会加载其中一端） ----
type SharedState = {
  refs: number
  ctx: any
  defaultTag: string
  controller: AbortController
  started: boolean
  subTimer?: ReturnType<typeof setTimeout>
  lastSpawnAt: number
  lastSoundAt: number
  asked: Set<string>
}

// V2 会为每个 location 各实例化一次插件（连模块作用域都是新的），但事件流是全局的：
// 若每个实例都订阅，一次完成就会弹出 N 个通知（N = 打开的 location 数），
// 多个 SoundPlayer 同时播放就是"爆音"。所以订阅、节流与去重状态统一挂 globalThis。
const sharedState = (): SharedState => {
  const g = globalThis as any
  if (!g.__ocDesktopNotify) {
    const st: SharedState = {
      refs: 0,
      ctx: null,
      defaultTag: "",
      controller: new AbortController(),
      started: false,
      lastSpawnAt: 0,
      lastSoundAt: 0,
      asked: new Set<string>(),
    }
    g.__ocDesktopNotify = st
  }
  return g.__ocDesktopNotify
}

let clickJumpReady = false
const erroredAt = new Map<string, number>()
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

const ensureClickJump = async () => {
  if (clickJumpReady) return
  clickJumpReady = true
  try {
    const proc = Bun.spawn(["cmd.exe", "/c", "echo", "%USERPROFILE%"], {
      cwd: "/mnt/c",
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    const m = /^([A-Za-z]):[\\/](.+?)\s*$/.exec(output.trim())
    if (!m) return
    const winPath = `${m[1]}:\\${m[2].replace(/\//g, "\\")}\\opencode-focus.ps1`
    const nixPath = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}/opencode-focus.ps1`
    await writeFile(nixPath, FOCUS_PS1).catch(() => {})
    const key1 = `HKCU\\Software\\Classes\\${PROTOCOL}`
    const key2 = `${key1}\\Shell\\Open\\Command`
    const handler = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${winPath}" "%1"`
    const regAdd = async (...args: string[]) =>
      Bun.spawn(["reg.exe", "add", ...args], { cwd: "/mnt/c", stdout: "ignore", stderr: "ignore" }).exited
    await regAdd(key1, "/ve", "/t", "REG_SZ", "/d", `URL:${PROTOCOL}`, "/f")
    await regAdd(key1, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f")
    await regAdd(key2, "/ve", "/t", "REG_SZ", "/d", handler, "/f")
  } catch {}
}

const buildScript = (kind: Kind, title: string, message: string, payload: string, withSound = true) => {
  const files = SOUND_FILES[kind].map((f) => `'C:\\Windows\\Media\\${f}'`).join(",")
  const launch = payload ? ` launch="${PROTOCOL}://f?${payload}" activationType="protocol"` : ""
  const xml = `<toast${launch} duration="short"><visual><binding template="ToastGeneric"><text>${escXml(title)}</text><text>${escXml(message)}</text></binding></visual><audio silent="true"/></toast>`
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "try {",
    "  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    "  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
    "  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `  $doc.LoadXml('${xml}')`,
    "  $toast = New-Object Windows.UI.Notifications.ToastNotification($doc)",
    `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
    "} catch { }",
  ]
  // 静音模式：只出通知条，不播放声音（避免与上一条通知的声音叠加）
  if (!withSound) return lines.join("\n")
  lines.push(
    "Add-Type -AssemblyName System.Media",
    `$files = @(${files})`,
    "$played = $false",
    "foreach ($f in $files) {",
    "  if (Test-Path $f) {",
    "    try { (New-Object Media.SoundPlayer $f).PlaySync() } catch { }",
    "    $played = $true",
    "    break",
    "  }",
    "}",
    "if (-not $played) {",
    `  [System.Media.SystemSounds]::${SYSTEM_SOUND[kind]}.Play()`,
    "  Start-Sleep -Milliseconds 800",
    "}",
  )
  return lines.join("\n")
}

const fire = (kind: Kind, message: string, tag: string) => {
  void ensureClickJump()
  const st = sharedState()
  const now = Date.now()
  if (now - st.lastSpawnAt < MIN_INTERVAL_MS) {
    trace(`fire throttled kind=${kind}`)
    return
  }
  st.lastSpawnAt = now
  // 连续多条通知（例如几个会话几乎同时结束）只让第一条出声，其余静音，
  // 否则多个 SoundPlayer 并行播放会互相叠加成爆音。
  const withSound = now - st.lastSoundAt >= SOUND_GAP_MS
  if (withSound) st.lastSoundAt = now
  debugLog(`fire kind=${kind} tag=${tag} sound=${withSound} msg=${message}`)
  trace(`fire kind=${kind} tag=${tag} sound=${withSound} msg=${oneLine(message, 80)}`)
  const payload = b64url([tag, "opencode", "ubuntu"].filter(Boolean).join("\n"))
  // 标题直接用项目名（取不到时退回 OpenCode），正文不再重复 [项目名]
  const encoded = Buffer.from(buildScript(kind, tag || "OpenCode", message, payload, withSound), "utf16le").toString("base64")
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      cwd: "/mnt/c",
      stdout: "ignore",
      stderr: "ignore",
    })
    setTimeout(() => { try { proc.kill() } catch {} }, SPAWN_TIMEOUT_MS)
    void proc.exited.then((rc) => trace(`spawn exit=${rc} kind=${kind}`)).catch((e) => trace(`spawn error=${e?.message ?? e}`))
  } catch (e: any) {
    trace(`spawn throw=${e?.message ?? e}`)
  }
}

// ---- V1 入口（opencode 1.18.29+ 支持对象形态；V2 会忽略 server） ----
async function server(input: any) {
  const { worktree, client } = input ?? {}
  const tag = baseTag(worktree)

  void client.app.log({
    body: { service: "desktop-notify", level: "info", message: "desktop-notify 插件已加载（WSL→Windows 声音+通知+点击跳转）" },
  })
  void ensureClickJump()

  return {
    event: async (raw: unknown) => {
      const ev = (raw as any)?.event
      if (!ev?.type) return
      const props = ev.properties ?? {}
      switch (ev.type as string) {
        case "session.idle": {
          const id = props.sessionID
          if (!id) break
          if (Date.now() - (erroredAt.get(id) ?? 0) < ERROR_SUPPRESS_MS) break
          const existing = pendingTimers.get(id)
          if (existing) clearTimeout(existing)
          pendingTimers.set(id, setTimeout(() => {
            pendingTimers.delete(id)
            void (async () => {
              try {
                const res = await client.session.get({ path: { id } })
                if ((res.data as any)?.parentID) return
                const msgs = await client.session.messages({ path: { id }, query: { limit: 1 } })
                const last = ((msgs.data ?? []) as any[]).pop()
                if (last?.info?.role === "assistant" && last.info.error) return
                const noContent = !last || (last.info?.role === "assistant" &&
                  !(last.parts ?? []).some((p: any) => p.type === "text" && String(p.text ?? "").trim()))
                if (noContent) return
              } catch (e: any) {
                trace(`v1 session.get fail sid=${id} ${e?.name ?? ""} ${e?.message ?? e}`)
                return
              }
              fire("info", "任务已完成，等你回来查看", tag)
            })()
          }, IDLE_DEBOUNCE_MS))
          break
        }
        case "session.error": {
          const id = props.sessionID
          if (!id) break
          const t = pendingTimers.get(id)
          if (t) { clearTimeout(t); pendingTimers.delete(id) }
          erroredAt.set(id, Date.now())
          const rawMsg = `${props.error?.name ?? ""} ${props.error?.message ?? ""}`
          if (/abort|cancel|interrupt|stop/i.test(rawMsg)) break
          fire("error", oneLine(rawMsg.trim(), 200) || "任务异常终止", tag)
          break
        }
        case "permission.asked": {
          const title = String(props.title ?? props.type ?? "")
          fire("ask", `等待权限确认：${oneLine(title, 120) || "需要你的批准"}`, tag)
          break
        }
      }
    },
    "tool.execute.before": async (i: any, o: any) => {
      if (String(i?.tool).toLowerCase() !== "question") return
      const callID = String(i?.callID ?? "")
      const asked = sharedState().asked
      if (callID && asked.has(callID)) return
      if (asked.size > 256) asked.clear()
      if (callID) asked.add(callID)
      const q = oneLine(pickText(o?.args) || JSON.stringify(o?.args ?? {}), 200)
      fire("ask", `AI 有问题要问你：${q}`, tag)
    },
  }
}

// ---- V2 入口（V1 会忽略 setup，只调 server） ----
export default {
  ...Plugin.define({
    id: "desktop-notify",
    async setup(ctx) {
      const defaultTag = baseTag(ctx.location.directory)
      const st = sharedState()
      st.ctx = ctx
      st.defaultTag = defaultTag
      st.refs += 1
      if (st.refs === 1) {
        console.log("desktop-notify 插件已加载（WSL→Windows 声音+通知+点击跳转）")
      }
      void ensureClickJump()

      await ctx.tool.hook("execute.before", (event) => {
        if (String((event as any)?.tool ?? "").toLowerCase() !== "question") return
        const callID = String((event as any)?.id ?? (event as any)?.callID ?? "")
        const asked = sharedState().asked
        if (callID && asked.has(callID)) return
        if (asked.size > 256) asked.clear()
        if (callID) asked.add(callID)
        const input = (event as any)?.input ?? {}
        const q = oneLine(pickText(input) || JSON.stringify(input), 200)
        fire("ask", `AI 有问题要问你：${q}`, defaultTag)
      })

      // 一轮执行结束（正常完成）→ 防抖后确认这是主线会话且确有产出，再弹通知。
      // 2.0.x 用 session.idle，2.1.x 起改为 session.execution.succeeded，两个都接；
      // 同一会话重复触发时重置同一个 timer，天然去重。
      const scheduleCompleted = (id: string, eventDir?: string) => {
        if (Date.now() - (erroredAt.get(id) ?? 0) < ERROR_SUPPRESS_MS) return
        const existing = pendingTimers.get(id)
        if (existing) clearTimeout(existing)
        pendingTimers.set(id, setTimeout(() => {
          pendingTimers.delete(id)
          void (async () => {
            let tag = baseTag(eventDir) || st.defaultTag
            try {
              const res: any = await st.ctx.session.get({ sessionID: id })
              const info = res?.data ?? res
              if (info?.parentID) return
              // 2.1.x 的 Session.Info 用 location.directory，旧版用 directory
              const sessionDir = info?.directory ?? info?.location?.directory
              if (sessionDir) tag = baseTag(sessionDir) || tag
              const msgs: any = await st.ctx.session.context({ sessionID: id })
              const list = Array.isArray(msgs) ? msgs : (msgs?.data ?? [])
              const last = (list as any[]).pop()
              if (last?.info?.role === "assistant" && last.info.error) return
              const noContent = !last || (last.info?.role === "assistant" &&
                !(last.parts ?? []).some((p: any) => p.type === "text" && String(p.text ?? "").trim()))
              if (noContent) return
            } catch (e: any) {
              trace(`session.get/context fail sid=${id} ${e?.name ?? ""} ${e?.message ?? e}`)
              return
            }
            fire("info", "任务已完成，等你回来查看", tag)
          })()
        }, IDLE_DEBOUNCE_MS))
      }

      // 执行失败/中断 → 取消待发的完成通知，并弹错误通知。
      const scheduleFailed = (id: string, rawMsg: string, eventDir?: string) => {
        const t = pendingTimers.get(id)
        if (t) { clearTimeout(t); pendingTimers.delete(id) }
        erroredAt.set(id, Date.now())
        const msg = rawMsg.trim()
        if (/abort|cancel|interrupt|stop/i.test(msg)) return
        fire("error", oneLine(msg, 200) || "任务异常终止", baseTag(eventDir) || st.defaultTag)
      }

      // 同一进程只跑一份事件订阅：5 个 location 会在同一瞬间各 setup 一次，用短防抖合并成一次订阅。
      // 不复用已有订阅，而是每次都重建：订阅可能已经静默死掉（流错误被吞、started 卡在 true），
      // 那时新 setup 只会 attach 到一个不存在的 loop 上。重建才能自愈，热重载也一定能恢复。
      if (st.subTimer) clearTimeout(st.subTimer)
      const controller = new AbortController()
      st.subTimer = setTimeout(() => {
        st.subTimer = undefined
        if (st.refs <= 0) return
        const previous = st.controller
        st.started = true
        st.controller = controller
        if (previous && previous !== controller) { try { previous.abort() } catch {} }
        debugLog(`setup v2 subscribe dir=${ctx.location.directory} refs=${st.refs}`)
        trace(`subscribe begin dir=${ctx.location.directory} refs=${st.refs}`)
        void (async () => {
          let attempt = 0
          while (!controller.signal.aborted) {
            attempt += 1
            try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          attempt = 0
          try {
            const type = (event as any)?.type as string | undefined
            if (!type) continue
            // V2 信封：{ type, data, location? }；兼容旧的 properties 形态
            const data = (event as any)?.data ?? (event as any)?.properties ?? {}
            const eventDir = (event as any)?.location?.directory
            debugLog(`event ${type} sid=${data.sessionID ?? ""} dir=${eventDir ?? ""}`)
            switch (type) {
              case "session.idle": // 2.0.x 及更早的完成信号
              case "session.execution.succeeded": { // 2.1.x 起的完成信号
                const id = data.sessionID ?? (event as any)?.sessionID
                if (!id) break
                scheduleCompleted(id, eventDir)
                break
              }
              case "session.execution.failed": {
                const id = data.sessionID ?? (event as any)?.sessionID
                if (!id) break
                const err = data.error ?? {}
                scheduleFailed(id, `${err.name ?? err.type ?? err._tag ?? ""} ${err.message ?? pickText(err)}`, eventDir)
                break
              }
              case "session.execution.interrupted": {
                // user/superseded/shutdown/inactivity：主动中止或生命周期事件，不打扰
                const id = data.sessionID ?? (event as any)?.sessionID
                if (!id) break
                const t = pendingTimers.get(id)
                if (t) { clearTimeout(t); pendingTimers.delete(id) }
                break
              }
              case "session.status": {
                // 旧版失败信号：status=retry（message + 可选 action）
                const id = data.sessionID ?? (event as any)?.sessionID
                if (!id) break
                if (data.status?.type !== "retry") break
                const action = data.status?.action
                scheduleFailed(id, `${action?.title ?? ""} ${action?.message ?? ""} ${data.status?.message ?? ""}`, eventDir)
                break
              }
              case "session.error": {
                // 兜底：若服务端仍发出旧事件名，保持 V1 行为
                const id = data.sessionID ?? (event as any)?.sessionID
                if (!id) break
                const err = data.error ?? {}
                scheduleFailed(id, `${err.name ?? err.type ?? err._tag ?? ""} ${err.message ?? ""}`, eventDir)
                break
              }
              case "permission.asked": {
                // V2 data：{ sessionID, action, resources, message? }，无 title 字段
                const bits = [data.message, data.action, ...(data.resources ?? [])].filter(Boolean).map(String)
                const title = bits.join(" ").trim()
                fire("ask", `等待权限确认：${oneLine(title, 120) || "需要你的批准"}`, baseTag(eventDir) || st.defaultTag)
                break
              }
            }
          } catch {}
        }
              trace(`stream ended cleanly attempt=${attempt}`)
            } catch (e: any) {
              if (controller.signal.aborted) break
              trace(`stream error attempt=${attempt} ${e?.name ?? ""} ${e?.message ?? e}`)
            }
            if (controller.signal.aborted) break
            if (attempt >= 5) {
              trace("stream giving up after 5 attempts")
              if (st.controller === controller) st.started = false
              break
            }
            await new Promise((r) => setTimeout(r, Math.min(5000, 400 * attempt)))
          }
          trace(`stream loop exit aborted=${controller.signal.aborted} started=${st.started}`)
        })()
      }, 250)

      let teardown: ReturnType<typeof setTimeout> | undefined
      return () => {
        st.refs -= 1
        if (st.refs > 0) return
        // 热重载时旧实例的 cleanup 可能早于新实例的 setup：先等一会儿，
        // 若期间有新实例接管（refs>0）就不停订阅，否则才真正退出。
        if (teardown) clearTimeout(teardown)
        teardown = setTimeout(() => {
          if (st.refs > 0) return
          if (st.subTimer) { clearTimeout(st.subTimer); st.subTimer = undefined }
          st.started = false
          st.controller.abort()
          for (const t of pendingTimers.values()) clearTimeout(t)
          pendingTimers.clear()
        }, 5000)
      }
    },
  }),
  server,
}
