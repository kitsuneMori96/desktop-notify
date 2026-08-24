# OpenCode Plugins

一组用于 [OpenCode](https://opencode.ai) 的实用插件。

## 插件列表

### auto-continue.ts

自动续写插件。当 AI 输出被截断时（未完成的代码块、列表等），自动发送"继续"让 AI 完成输出。

**特性：**
- 检测未完成的代码块（` ``` `）
- 检测悬空的标点符号和括号
- 智能冷却机制，避免无限循环
- 熔断保护（最多续写 10 次）
- 支持 todo 任务催促

### bash-timeout.ts

Bash 命令超时插件。为 bash 命令添加超时控制，防止长时间运行的命令阻塞。

**特性：**
- 自动识别长时间运行的命令（如 `npm run dev`、`docker` 等）
- 长时命令默认 30 秒超时，普通命令 5 分钟超时
- 可自定义超时时间
- 输出截断保护（最大 50KB）
- 包含探针工具 `hello_probe` 用于验证插件加载

### desktop-notify.ts

桌面通知插件（WSL → Windows）。在 WSL 环境下向 Windows 发送声音通知和 Toast 通知。

**特性：**
- 任务完成通知
- 错误通知
- 权限请求通知
- 点击通知跳转到终端窗口
- 支持多种 Windows 终端（Windows Terminal、WezTerm 等）

## 安装

1. 将插件文件复制到 `~/.config/opencode/plugins/` 目录：

```bash
cp *.ts ~/.config/opencode/plugins/
```

2. 重启 OpenCode 即可生效。

## 配置

插件默认配置即可使用。如需自定义，可修改插件源码中的常量：

- `auto-continue.ts`: 修改 `MAX_FUSE`、`BASE_COOLDOWN_MS` 等参数
- `bash-timeout.ts`: 修改 `HANGY_TIMEOUT_MS`、`DEFAULT_TIMEOUT_MS` 等参数
- `desktop-notify.ts`: 无需特殊配置

## 依赖

- `@opencode-ai/plugin` (OpenCode 插件 SDK)

## License

MIT
