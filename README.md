# Browser Verify for Claude Code

**English** | [简体中文](README.zh-CN.md)

A Claude Code plugin marketplace containing the `browser-verify` skill and its
dependency-free Chrome DevTools scripts.

## Install with Claude Code

From GitHub:

```bash
claude plugin marketplace add reeij/browser-verify
claude plugin install browser-verify@browser-verify-marketplace
```

From a local checkout:

```bash
claude plugin marketplace add /absolute/path/to/browser-verify-marketplace
claude plugin install browser-verify@browser-verify-marketplace
```

Restart Claude Code after installation, or run `/reload-plugins` in a session.

## Requirements

- Node.js 22 or newer
- Google Chrome (auto-detected; set `CHROME_PATH` if it lives elsewhere)
- macOS, Linux, or Windows

## Viewport

By default the page fills the real Chrome window: no device emulation is
applied, so resizing the window resizes the page. Opt into an emulated viewport
when starting the daemon:

```bash
BROWSERD_WIDTH=390 BROWSERD_HEIGHT=844 BROWSERD_MOBILE=1 \
  node scripts/daemon.mjs start
```

`POST http://127.0.0.1:9334/viewport` changes it at runtime; posting `{}`
returns to the real window.

## Install as a personal skill instead

If the target app supports personal skills but not plugins, copy the skill
directory:

```bash
mkdir -p ~/.claude/skills
cp -R plugins/browser-verify/skills/browser-verify ~/.claude/skills/
```

## Releasing a new version

The version is set in three places and must stay in sync:

- `metadata.version` and `plugins[0].version` in `.claude-plugin/marketplace.json`
- `version` in `plugins/browser-verify/.claude-plugin/plugin.json`

Increment `version` in all three before pushing a release. Claude Code only
offers an update when the version changes; pushing commits with an unchanged
version leaves users on their old copy and makes `claude plugin update` report
`already at the latest version`.

The `homepage` and `repository` fields in `plugin.json` point at this repository.

## Contents

```text
.claude-plugin/marketplace.json
plugins/browser-verify/.claude-plugin/plugin.json
plugins/browser-verify/skills/browser-verify/SKILL.md
plugins/browser-verify/skills/browser-verify/scripts/browser.mjs
plugins/browser-verify/skills/browser-verify/scripts/browserd.mjs
plugins/browser-verify/skills/browser-verify/scripts/daemon.mjs
plugins/browser-verify/skills/browser-verify/scripts/chrome.mjs
LICENSE
```

The exported copy uses daemon port `9334` and a throwaway Chrome profile under
the system temp directory (`os.tmpdir()`), so it can coexist with a Codex copy
using port `9333`. Override them with `BROWSERD_PORT` / `BROWSERD_URL`.

## License

MIT
