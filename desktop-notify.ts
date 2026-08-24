import type { Plugin } from "@opencode-ai/plugin"
import { writeFile } from "node:fs/promises"

const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"
const PROTOCOL = "opencode-focus"
const MIN_INTERVAL_MS = 400
const SPAWN_TIMEOUT_MS = 15_000
const ERROR_SUPPRESS_MS = 10_000

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

export default (async ({ $, worktree, client }) => {
  const tag = String(worktree || "").split("/").filter(Boolean).pop() ?? ""
  let lastSpawnAt = 0
  let clickJumpReady = false
  const erroredAt = new Map<string, number>()
  const askedCalls = new Set<string>()

  void client.app.log({
    body: { service: "desktop-notify", level: "info", message: "desktop-notify 插件已加载（WSL→Windows 声音+通知+点击跳转）" },
  })

  const ensureClickJump = async () => {
    if (clickJumpReady) return
    clickJumpReady = true
    try {
      const r = await $`cd /mnt/c && cmd.exe /c echo %USERPROFILE%`.quiet().nothrow()
      const m = /^([A-Za-z]):[\\/](.+?)\s*$/.exec(String((r as any)?.stdout ?? "").trim())
      if (!m) return
      const winPath = `${m[1]}:\\${m[2].replace(/\//g, "\\")}\\opencode-focus.ps1`
      const nixPath = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}/opencode-focus.ps1`
      await writeFile(nixPath, FOCUS_PS1).catch(() => {})
      const key1 = `HKCU\\Software\\Classes\\${PROTOCOL}`
      const key2 = `${key1}\\Shell\\Open\\Command`
      const handler = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${winPath}" "%1"`
      await $`reg.exe add ${key1} /ve /t REG_SZ /d "URL:${PROTOCOL}" /f`.quiet().nothrow()
      await $`reg.exe add ${key1} /v "URL Protocol" /t REG_SZ /d "" /f`.quiet().nothrow()
      await $`reg.exe add ${key2} /ve /t REG_SZ /d ${handler} /f`.quiet().nothrow()
    } catch {}
  }
  void ensureClickJump()

  const buildScript = (kind: Kind, title: string, message: string, payload: string) => {
    const files = SOUND_FILES[kind].map((f) => `'C:\\Windows\\Media\\${f}'`).join(",")
    const launch = payload ? ` launch="${PROTOCOL}://f?${payload}" activationType="protocol"` : ""
    const xml = `<toast${launch} duration="short"><visual><binding template="ToastGeneric"><text>${escXml(title)}</text><text>${escXml(message)}</text></binding></visual><audio silent="true"/></toast>`
    return [
      "$ErrorActionPreference = 'SilentlyContinue'",
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
      "try {",
      "  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
      "  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
      "  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `  $doc.LoadXml('${xml}')`,
      "  $toast = New-Object Windows.UI.Notifications.ToastNotification($doc)",
      `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
      "} catch { }",
    ].join("\n")
  }

  const fire = (kind: Kind, message: string) => {
    void ensureClickJump()
    const now = Date.now()
    if (now - lastSpawnAt < MIN_INTERVAL_MS) return
    lastSpawnAt = now
    const payload = b64url([tag, "opencode", "ubuntu"].filter(Boolean).join("\n"))
    const encoded = Buffer.from(buildScript(kind, "OpenCode", message, payload), "utf16le").toString("base64")
    void (async () => {
      try {
        const proc = $`cd /mnt/c && powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`
          .quiet()
          .nothrow()
        await Promise.race([proc, new Promise((r) => setTimeout(r, SPAWN_TIMEOUT_MS))])
      } catch {}
    })()
  }

  return {
    event: async (input: unknown) => {
      const ev = (input as any)?.event
      if (!ev?.type) return
      const props = ev.properties ?? {}
      switch (ev.type as string) {
        case "session.idle": {
          const id = props.sessionID
          if (!id) break
          if (Date.now() - (erroredAt.get(id) ?? 0) < ERROR_SUPPRESS_MS) break
          try {
            const res = await client.session.get({ path: { id } })
            if ((res.data as any)?.parentID) break
          } catch {}
          fire("info", tag ? `[${tag}] 任务已完成，等你回来查看` : "任务已完成，等你回来查看")
          break
        }
        case "session.error": {
          const id = props.sessionID
          if (!id) break
          const name = String(props.error?.name ?? "")
          if (/abort|cancel/i.test(name)) break
          erroredAt.set(id, Date.now())
          fire("error", oneLine(`${name} ${props.error?.message ?? ""}`.trim(), 200) || "任务异常终止")
          break
        }
        case "permission.asked": {
          const title = String(props.title ?? props.type ?? "")
          fire("ask", `等待权限确认：${oneLine(title, 120) || "需要你的批准"}`)
          break
        }
      }
    },
    "tool.execute.before": async (input: any, output: any) => {
      if (String(input?.tool).toLowerCase() !== "question") return
      const callID = String(input?.callID ?? "")
      if (callID && askedCalls.has(callID)) return
      if (askedCalls.size > 256) askedCalls.clear()
      if (callID) askedCalls.add(callID)
      const q = oneLine(pickText(output?.args) || JSON.stringify(output?.args ?? {}), 200)
      fire("ask", `AI 有问题要问你：${q}`)
    },
  }
}) satisfies Plugin
