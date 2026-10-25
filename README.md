# OpenCode Plugins

一组用于 [OpenCode](https://opencode.ai) 的实用插件。

> 仓库现在只有 `desktop-notify.ts`。早期的 `auto-continue.ts`（自动续写）和
> `bash-timeout.ts`（bash 超时）已过时并移除，历史版本见 git log。

## 插件列表

### desktop-notify.ts

桌面通知插件（WSL → Windows）。在 WSL 环境下向 Windows 发送声音通知和 Toast 通知。

**特性：**
- 任务完成通知
- 错误通知
- 权限请求通知
- 点击通知跳转到终端窗口
- 支持多种 Windows 终端（Windows Terminal、WezTerm 等）
- OpenCode V1/V2 双形态（`server()` 与 `setup()` 共用同一套逻辑）
- 事件订阅断流自愈：流被服务端关闭后自动退避重连，不再静默失效
- 常开 trace：`/tmp/opencode/desktop-notify-trace.log`（订阅建立/断流/fire/spawn 退出码）

### 排障

`desktop-notify.ts` 不再依赖 `DESKTOP_NOTIFY_DEBUG` 环境变量（服务进程通常拿不到）。
插件"看起来已加载但没通知"时，直接看 trace：

```bash
tail -20 /tmp/opencode/desktop-notify-trace.log
```

- 只有 `subscribe begin` 没有 `stream error` / `stream loop exit` → 订阅活着，问题在 Windows 投递
- 反复 `stream error` → 事件流连不上（服务端重启/协议变更）
- 有 `fire` 但无 `spawn exit=0` → PowerShell 侧失败

## 安装

1. 将插件文件复制到 `~/.config/opencode/plugins/` 目录：

```bash
cp desktop-notify.ts ~/.config/opencode/plugins/
```

2. 重启 OpenCode 即可生效。

## 配置

`desktop-notify.ts` 默认配置即可使用，无需特殊配置。

## 依赖

- `@opencode/plugin` (OpenCode V2 插件 SDK，`desktop-notify.ts` 直接依赖)
- `@opencode-ai/plugin` (OpenCode V1 插件 SDK，V1 环境或类型检查需要)

## License

MIT
