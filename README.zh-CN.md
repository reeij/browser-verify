# Browser Verify for Claude Code

[English](README.md) | **简体中文**

一个 Claude Code 插件市场仓库，包含 `browser-verify` skill 及其无第三方依赖的
Chrome DevTools 脚本。

## 安装

通过 GitHub 安装：

```bash
claude plugin marketplace add reeij/browser-verify
claude plugin install browser-verify@browser-verify-marketplace
```

从本地目录安装：

```bash
claude plugin marketplace add /absolute/path/to/browser-verify-marketplace
claude plugin install browser-verify@browser-verify-marketplace
```

安装后重启 Claude Code，或在会话中执行 `/reload-plugins`。

## 环境要求

- Node.js 22 或更高版本
- Google Chrome
- **macOS**：skill 使用 `launchctl` 启动守护进程，使用 `open -na` 启动 Chrome。
  Linux 和 Windows 需要等价的守护进程启动命令和 Chrome 启动命令；脚本本身是
  跨平台的。

## 作为个人 skill 安装

如果目标应用支持个人 skill 但不支持插件，直接复制 skill 目录：

```bash
mkdir -p ~/.claude/skills
cp -R plugins/browser-verify/skills/browser-verify ~/.claude/skills/
```

## 发布新版本

版本号分布在三个位置，必须保持同步：

- `.claude-plugin/marketplace.json` 中的 `metadata.version` 和 `plugins[0].version`
- `plugins/browser-verify/.claude-plugin/plugin.json` 中的 `version`

推送发布前把三处版本号都递增。Claude Code 只在版本号变化时提供更新；如果版本号
不变就推送提交，用户会一直停留在旧副本，`claude plugin update` 会提示
`already at the latest version`。

`plugin.json` 中的 `homepage` 和 `repository` 已指向本仓库。

## 目录结构

```text
.claude-plugin/marketplace.json
plugins/browser-verify/.claude-plugin/plugin.json
plugins/browser-verify/skills/browser-verify/SKILL.md
plugins/browser-verify/skills/browser-verify/scripts/browser.mjs
plugins/browser-verify/skills/browser-verify/scripts/browserd.mjs
LICENSE
```

导出的副本使用守护进程端口 `9334` 和临时 Chrome profile
`/tmp/claude-browser-profile`，因此可以与使用 `9333` 端口的 Codex 副本共存。
可通过 `BROWSERD_PORT` / `BROWSERD_URL` 覆盖。

## 许可证

MIT
