import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const HANGY_TIMEOUT_MS = 30_000
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_BYTES = 51_200

const HANGY =
  /\b(dev|watch|serve|server|listen|watchman|nodemon)\b|^npm (run )?(dev|start|watch)\b|^pnpm (dev|start|watch)\b|^yarn (dev|start|watch)\b|^cargo watch\b|^docker (run|compose up)\b|^docker-compose up\b|^(sudo|ssh|su|telnet|ftp|nc|socat|vim|vi|nano|less|more|top|htop|read)\b/

function resolveTimeout(timeout: number | undefined, command: string): number {
  if (timeout != null) return timeout
  return HANGY.test(command) ? HANGY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

async function runWithTimeout(command: string, timeoutMs: number, cwd: string) {
  const shell = process.env.SHELL?.includes("zsh") ? process.env.SHELL : "/bin/zsh"
  let proc: ReturnType<typeof Bun.spawn> | undefined
  let stdout = ""
  let stderr = ""
  let killedByTimeout = false
  let exitCode: number | null = null

  const timer = setTimeout(() => {
    killedByTimeout = true
    try {
      proc?.kill("SIGKILL")
    } catch {}
  }, timeoutMs)

  try {
    proc = Bun.spawn([shell, "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    const collect = async (
      stream: ReadableStream<Uint8Array>,
      into: (chunk: string) => void,
    ) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        into(buf)
        buf = ""
      }
      if (buf) into(buf)
    }

    await Promise.all([
      collect(proc.stdout, (c) => (stdout += c)),
      collect(proc.stderr, (c) => (stderr += c)),
    ])
    exitCode = proc.exitCode
  } finally {
    clearTimeout(timer)
  }

  let out = (stdout + (stderr ? `\n${stderr}` : "")).trimEnd()
  if (out.length > MAX_BYTES) {
    out = `... (输出超过 ${MAX_BYTES} 字节，已截断) ...\n` + out.slice(-MAX_BYTES)
  }

  const header = `[exit_code: ${exitCode ?? "killed"}]`
  if (killedByTimeout) {
    return {
      title: `${header} [timeout: ${timeoutMs}ms]`,
      output: `${out}\n—— 命令在 ${timeoutMs / 1000}s 后未结束，已被强制终止。若确需更长执行时间，请显式传入更大的 timeout 参数。`,
    }
  }
  return {
    title: header,
    output: out || "(无输出)",
  }
}

export default (async ({ client }) => {
  await client.app.log({
    body: {
      service: "bash-timeout",
      level: "info",
      message: "bash-timeout plugin loaded (custom bash tool)",
    },
  })
  return {
    tool: {
      hello_probe: tool({
        description:
          "探针工具：验证自定义插件工具是否可用。调用它并查看返回值。",
        args: {},
        async execute() {
          return `probe ok ${Date.now()}`
        },
      }),
      bash: tool({
        description:
          "运行一条 shell 命令并等待其结束。命令结束于超时时间（可传 timeout 参数指定毫秒数；不传时自动按命令选择：交互/常驻类 30s，其余 300s），超时会被强制终止，不会无限阻塞。",
        args: {
          command: tool.schema
            .string()
            .describe("要执行的 shell 命令，如 ls -la"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("超时毫秒数，例如 60000；省略时自动选择策略值"),
        },
        async execute(args, context) {
          const timeoutMs = resolveTimeout(args.timeout, args.command)
          return await runWithTimeout(args.command, timeoutMs, context.directory)
        },
      }),
    },
  }
}) satisfies Plugin