# 这个目录是 git 仓库，不是普通插件投放目录

`~/.config/opencode/plugins/` 是 <https://github.com/kitsuneMori96/opencode-plugins>
的克隆（`origin` 走 SSH，分支 `main`）。OpenCode 直接从这里加载 `*.ts`，
所以**在这里改插件 = 改仓库源码**，不是改一份无关的本地副本。

## 改动的规矩

- 改完立即提交并推送，提交信息用中文 conventional 格式，说明「为什么」：
  `fix(desktop-notify): 修复订阅断流后的静默失效，并加常开 trace`
- 只提交源码与文档；`node_modules/`、`*.log` 已在 `.gitignore` 里
- 推送前 `git status` 应干净；不要 `force push`，不要改写已推送的历史
- 新增插件：直接放 `*.ts` 到本目录并提交，README 的插件列表要同步

## 边界

- 本目录只放插件源码。OpenCode 的配置在**上一级** `opencode.jsonc`
  （含 winremote Bearer token 等密钥），**不要**复制进来，也不要把任何
  密钥/令牌写进本仓库
- 加载生效需要重启 OpenCode（或 `opencode serve`）
- 插件运行痕迹集中在 `/tmp/opencode/`，例如桌面通知的
  `desktop-notify-trace.log`；排障先看 trace，再看 `journalctl` 之类的外部日志
- 本文件是 `agent.md`；`AGENTS.md` 是指向它的符号链接，方便自动加载
