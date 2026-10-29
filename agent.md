# 插件目录：仓库本体在 `../.plugins-git`

`~/.config/opencode/plugins/` 只是 OpenCode 的插件加载目录（它直接加载这里的
`*.ts`）。**版本库不在这个目录里**，真正的 git 目录在上一级：

```
~/.config/opencode/.plugins-git/   真正的仓库（.git 本体，含 remote / 历史 / 分支）
~/.config/opencode/plugins/        工作区：OpenCode 从这里加载 *.ts
```

`plugins/.git` 只是一个 gitlink 文件（内容一行 `gitdir: /home/kitsunemori/.config/opencode/.plugins-git`），
所以在这里 `git status` / `git commit` / `git push` 照常可用，改动自动落到
<https://github.com/kitsuneMori96/desktop-notify>（SSH，分支 `main`）。

## 为什么不能把 `.git/` 放回本目录

OpenCode 2.1.x 扫描 `plugins/` 时把**每个子目录**当成一个插件包（入口取
`index.ts`），只跳过非 `*.ts`/`*.js` 的文件。所以一旦这里是 `.git/` 目录，
它会被当成插件加载并报错：

```
Status: failed / Plugin: ~/.config/opencode/plugins/.git
cause: AggregateError: 2 errors building ".../plugins/.git/index"
```

**不要**在这个目录里 `git init` / `git clone`。要重建工作区：

```bash
cd ~/.config/opencode
rm -rf plugins/.git
git clone --separate-git-dir ~/.config/opencode/.plugins-git \
  git@github.com:kitsuneMori96/desktop-notify.git /tmp/desktop-notify-checkout
# 或：已有 .plugins-git 时，只把 gitlink 文件写回来
printf 'gitdir: %s\n' "$PWD/.plugins-git" > plugins/.git
opencode reload    # 重扫插件，无需重启
```

## 改动的规矩

- 在这里改 `*.ts` 就是改仓库源码；改完立即提交推送，中文 conventional 提交信息：
  `fix(desktop-notify): 修复订阅断流后的静默失效，并加常开 trace`
- 只提交源码与文档；`node_modules/`、`*.log` 已在 `.gitignore` 里
- 推送前 `git status` 应干净；不要 `force push`，不要改写已推送的历史
- 新增插件：直接放 `*.ts` 到本目录并提交，README 的插件列表要同步

## 边界

- 本目录只放插件源码。OpenCode 的配置在**上一级** `opencode.jsonc`
  （含 winremote Bearer token 等密钥），**不要**复制进来，也不要把任何
  密钥/令牌写进仓库
- 加载生效执行 `opencode reload` 即可（重扫插件）；改的是服务端插件时也可重启 OpenCode
- 插件运行痕迹集中在 `/tmp/opencode/`，例如桌面通知的
  `desktop-notify-trace.log`；排障先看 trace，再看 `journalctl` 之类的外部日志
- 本文件是 `agent.md`；`AGENTS.md` 是指向它的符号链接，方便自动加载
