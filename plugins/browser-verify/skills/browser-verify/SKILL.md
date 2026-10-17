---
name: browser-verify
description: >
  Drive a real Chrome window through the DevTools protocol to open pages, log in,
  click, fill forms, read page state, and capture screenshots. Use when the user asks
  to open or inspect a web page, verify a feature in the browser, reproduce a UI bug,
  run browser-based functional or end-to-end checks, or screenshot a local dev site.
  Works with any URL reachable from this machine, including localhost dev servers.
---

# Browser Verify

Controls a Chrome instance over the DevTools protocol so page state can be read and
acted on directly, not guessed from pixels. Screenshots are for verification, not for
finding coordinates.

## Layout

| Path | Purpose |
| --- | --- |
| `scripts/browser.mjs` | Client. Every command you run goes through this. |
| `scripts/browserd.mjs` | Long-lived CDP session that holds the emulated viewport. |

Both are dependency-free (Node 22 built-ins). Set `SKILL_DIR` to this skill's directory
before running anything below.

## Preconditions

Two things must be running: Chrome with a debug port, and the daemon. Check first:

```bash
curl -s --max-time 4 http://127.0.0.1:9334/health   # daemon
curl -s --max-time 4 http://127.0.0.1:9222/json/version | head -2   # chrome
```

If Chrome is missing, launch it with a throwaway profile. Do not reuse the user's
normal Chrome profile: this instance gets credentials typed into it.

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/claude-browser-profile \
  --no-first-run --no-default-browser-check about:blank
```

If the daemon is missing, start it detached so it survives the command:

```bash
launchctl submit -l com.claude.browserd -- "$(command -v node)" \
  "$SKILL_DIR/scripts/browserd.mjs"
```

Stop it later with `launchctl remove com.claude.browserd`. Close the browser with
`browser.mjs quit`.

## Running commands

Every `browser.mjs` invocation needs direct network access to `127.0.0.1`. Run it
through the normal Bash tool. If an execution sandbox blocks loopback connections,
allow localhost access for the command before retrying.

```bash
node "$SKILL_DIR/scripts/browser.mjs" <command> [args]
```

| Command | Does |
| --- | --- |
| `tabs` | List open pages as `id  title  url` |
| `open <url>` | Navigate the attached page, wait for load |
| `reload` / `back` | Reload, or go back one entry |
| `text [pattern]` | Dump visible text, or only lines containing `pattern` |
| `eval "<js>"` | Evaluate an expression in the page, print the value |
| `tap "<visible text>"` | Click the smallest element whose text matches |
| `click <selector>` | Click a CSS selector |
| `fill <selector> <value>` | Set an input's value and fire input/change |
| `shot <path> [full]` | Screenshot to a file, `full` for the whole page |
| `resize <w> <h>` | Resize the real window (macOS floor is ~500px wide) |
| `closeall` / `quit` | Close all tabs, or close Chrome entirely |

Viewport defaults to a phone (390x844, 3x, iPhone UA) held open by the daemon. Override
per command with `CDP_WIDTH`, `CDP_HEIGHT`, `CDP_MOBILE=0`. Emulation is opt-in for one-off
commands precisely because a per-command override is dropped when the session detaches,
which makes the page visibly reflow. Keep the daemon running to avoid that flicker.

## Verification workflow

1. `open` the URL, then `shot` and actually view the image to confirm it rendered.
2. `eval` for ground truth instead of inferring from the picture: `location.href`,
   `document.readyState`, form values, `localStorage` keys, element counts.
3. Act with `tap`/`click`/`fill`, then re-read state to confirm the action landed.
4. Assert on concrete values. "登录 succeeded" means the token or user name is present,
   not that the page looks different.
5. Save screenshots to the project's output directory and reference them in the report.

Useful one-liners:

```bash
# what is on screen right now
node "$SKILL_DIR/scripts/browser.mjs" eval \
  'JSON.stringify({url:location.href,title:document.title,text:document.body.innerText.slice(0,300)})'

# did a form actually take the value
node "$SKILL_DIR/scripts/browser.mjs" eval \
  'JSON.stringify([...document.querySelectorAll("input")].map(i=>({t:i.type,v:i.value})))'

# what the app stored
node "$SKILL_DIR/scripts/browser.mjs" eval 'Object.keys(localStorage).join(",")'
```

## Element selection

Targets on modern SPAs are often custom elements (`uni-view`, `uni-button`) with no stable
hooks. Prefer, in order: a real `id`/`name` attribute, a distinctive class, then `tap` by
visible text. `tap` picks the smallest matching element and clicks whatever is topmost at
its centre, which handles overlays and duplicate labels.

Selector gotcha: an input with no `type` attribute does not match `input[type=text]`.
Match the property, not the attribute: `input:not([type=password])`.

## Safety

- Never type credentials into the user's normal Chrome profile. The throwaway profile
  above keeps personal cookies and logins out of reach.
- Read tokens and session state when needed for debugging, but do not print full secrets
  in the final report; truncate them.
- Actions that write to a backend (likes, orders, payments, deletes, sends) need explicit
  user confirmation first. Navigating, reading, and screenshots do not.
- Report what was actually verified, with the evidence. If a step only looked correct but
  was not asserted, say so.
