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
| `scripts/browserd.mjs` | Long-lived CDP session held open by the daemon. |
| `scripts/daemon.mjs` | Cross-platform `start` / `stop` / `status` for the daemon. |
| `scripts/chrome.mjs` | Cross-platform Chrome launcher with a throwaway profile. |

All are dependency-free (Node 22 built-ins) and run on macOS, Linux, and Windows.
Set `SKILL_DIR` to this skill's directory before running anything below.

## Preconditions

Two things must be running: Chrome with a debug port, and the daemon. Check first:

```bash
node "$SKILL_DIR/scripts/daemon.mjs" status
curl -s --max-time 4 http://127.0.0.1:9222/json/version | head -2   # chrome
```

Launch both with the cross-platform helpers (macOS, Linux, and Windows):

```bash
node "$SKILL_DIR/scripts/chrome.mjs"          # throwaway profile + debug port
node "$SKILL_DIR/scripts/daemon.mjs" start    # detached background daemon
```

`chrome.mjs` auto-detects Chrome; set `CHROME_PATH` if it is installed elsewhere.
Do not reuse the user's normal Chrome profile: this instance gets credentials
typed into it.

Stop the daemon with `daemon.mjs stop`. Close the browser with `browser.mjs quit`.
The same commands work from PowerShell or cmd on Windows.

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
| `resize <w> <h>` | Resize the real window; the content viewport follows (macOS floor is ~500px wide) |
| `closeall` / `quit` | Close all tabs, or close Chrome entirely |

By default the content viewport **fills the real Chrome window**: the daemon
applies no device emulation, so resizing the window resizes the page. To opt into
an emulated (mobile) viewport, start the daemon with it:

```bash
BROWSERD_WIDTH=390 BROWSERD_HEIGHT=844 BROWSERD_MOBILE=1 \
  node "$SKILL_DIR/scripts/daemon.mjs" start
```

PowerShell:

```powershell
$env:BROWSERD_WIDTH=390; $env:BROWSERD_HEIGHT=844; $env:BROWSERD_MOBILE=1
node "$SKILL_DIR/scripts/daemon.mjs" start
```

Change it at runtime, or return to the real window:

```bash
curl -X POST http://127.0.0.1:9334/viewport \
  -H 'content-type: application/json' \
  -d '{"width":390,"height":844,"mobile":true}'

curl -X POST http://127.0.0.1:9334/viewport \
  -H 'content-type: application/json' -d '{}'
```

For a one-off command without the daemon, set `CDP_WIDTH` / `CDP_HEIGHT` (add
`CDP_MOBILE=1` for mobile). A per-command override is dropped when the session
detaches, which makes the page visibly reflow; keep the daemon running to avoid
that flicker.

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
