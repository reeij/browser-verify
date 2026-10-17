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
- Google Chrome
- **macOS**: the skill starts the daemon with `launchctl` and launches Chrome
  with `open -na`. Linux and Windows need an equivalent daemon launch command
  and Chrome start command; the scripts themselves are cross-platform.

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
LICENSE
```

The exported copy uses daemon port `9334` and the temporary Chrome profile
`/tmp/claude-browser-profile`, so it can coexist with a Codex copy using port
`9333`. Override them with `BROWSERD_PORT` / `BROWSERD_URL`.

## License

MIT
