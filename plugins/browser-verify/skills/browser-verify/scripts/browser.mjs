#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol driver.
 *
 * Chrome must be running with --remote-debugging-port=9222.
 * Uses only Node built-ins (fetch + global WebSocket), so no install step.
 *
 * Usage:
 *   node browser.mjs tabs
 *   node browser.mjs open <url>
 *   node browser.mjs text [pattern]
 *   node browser.mjs eval "<js expression>"
 *   node browser.mjs click <selector>
 *   node browser.mjs tap <visible text>
 *   node browser.mjs fill <selector> <value>
 *   node browser.mjs shot <path> [full]
 *   node browser.mjs close
 *   node browser.mjs quit
 *   node browser.mjs resize <width> <height> [left] [top]
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CDP_PORT || 9222);
const HOST = `127.0.0.1:${PORT}`;
const DAEMON = process.env.BROWSERD_URL || "http://127.0.0.1:9334";
// Emulation is opt-in: by default the real window size is used, so the page
// never reflows when a command finishes and the CDP session detaches.
const EMULATE = process.env.CDP_WIDTH
  ? {
      width: Number(process.env.CDP_WIDTH),
      height: Number(process.env.CDP_HEIGHT || 844),
      mobile: process.env.CDP_MOBILE === "1",
    }
  : null;
const STATE_FILE = join(tmpdir(), "claude-browser-current");
const CHROME_SCRIPT = fileURLToPath(new URL("./chrome.mjs", import.meta.url));

const [, , command, ...args] = process.argv;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function listTargets() {
  let response;
  try {
    response = await fetch(`http://${HOST}/json/list`);
  } catch (error) {
    fail(
      `Cannot reach Chrome on port ${PORT}. Start it first with:\n` +
        `  node "${CHROME_SCRIPT}"\n` +
        `or launch Chrome yourself with --remote-debugging-port=${PORT}.`,
    );
  }
  const targets = await response.json();
  return targets.filter((t) => t.type === "page");
}

async function daemonHealth() {
  try {
    const response = await fetch(`${DAEMON}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health.ok ? health : null;
  } catch {
    return null;
  }
}

/**
 * Talks to browserd instead of Chrome directly. The daemon owns the only CDP
 * session, which is what keeps the mobile viewport applied between commands.
 */
class ProxySession {
  async send(method, params = {}) {
    const response = await fetch(`${DAEMON}/cdp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error);
    return payload.result;
  }

  close() {}
}

async function waitForReady(session, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(session, "document.readyState");
      if (state === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return true;
      }
    } catch {
      /* navigation may be in flight */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function openTab(url) {
  const response = await fetch(
    `http://${HOST}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!response.ok) fail(`Failed to open tab: HTTP ${response.status}`);
  return response.json();
}

async function rememberTarget(id) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(STATE_FILE, id, "utf8");
}

async function recallTarget() {
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(STATE_FILE, "utf8")).trim();
  } catch {
    return null;
  }
}

class Session {
  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (event) =>
        reject(new Error(`WebSocket error: ${event.message || "unknown"}`)),
      );
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const listener = (message) => {
        if (message.method === method) {
          this.listeners.delete(listener);
          resolve(message.params);
        }
      };
      this.listeners.add(listener);
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        resolve(null);
      }, timeoutMs);
      timer.unref();
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    fail(`Page error: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function pickTarget() {
  const targets = await listTargets();
  if (targets.length === 0) {
    fail("No open page found. Run: node browser.mjs open <url>");
  }
  const wanted = await recallTarget();
  return targets.find((t) => t.id === wanted) || targets[0];
}

async function connect(target) {
  const health = await daemonHealth();
  if (health) return new ProxySession();
  const session = new Session(target.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  if (EMULATE) {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: EMULATE.width,
      height: EMULATE.height,
      deviceScaleFactor: EMULATE.mobile ? 3 : 1,
      mobile: EMULATE.mobile,
    });
  }
  if (EMULATE?.mobile) {
    await session.send("Emulation.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
  }
  return session;
}

async function main() {
  if (!command) fail("Missing command. Try: tabs, open, text, eval, click, fill, shot, close");

  if (command === "tabs") {
    const targets = await listTargets();
    if (targets.length === 0) {
      console.log("(no open pages)");
      return;
    }
    for (const target of targets) {
      console.log(`${target.id}\t${target.title}\t${target.url}`);
    }
    return;
  }

  if (command === "open") {
    const url = args[0];
    if (!url) fail("Usage: node browser.mjs open <url>");
    const health = await daemonHealth();
    if (health) {
      const session = new ProxySession();
      await session.send("Page.navigate", { url });
      await waitForReady(session);
      console.log(
        await evaluate(
          session,
          "JSON.stringify({ title: document.title, url: location.href })",
        ),
      );
      return;
    }
    const target = await openTab(url);
    await rememberTarget(target.id);
    const session = await connect(target);
    const loaded = session.waitForEvent("Page.loadEventFired");
    await session.send("Page.navigate", { url });
    await loaded;
    const info = await evaluate(
      session,
      "JSON.stringify({ title: document.title, url: location.href })",
    );
    console.log(info);
    session.close();
    return;
  }

  if (command === "reload") {
    const session = await connect(await pickTarget());
    await session.send("Page.reload", { ignoreCache: false });
    await waitForReady(session);
    console.log(
      await evaluate(
        session,
        "JSON.stringify({ title: document.title, url: location.href })",
      ),
    );
    return;
  }

  if (command === "back") {
    const session = await connect(await pickTarget());
    await evaluate(session, "history.back(), null");
    await waitForReady(session);
    console.log(
      await evaluate(
        session,
        "JSON.stringify({ title: document.title, url: location.href })",
      ),
    );
    return;
  }

  if (command === "closeall") {
    const targets = await listTargets();
    for (const target of targets) {
      await fetch(`http://${HOST}/json/close/${target.id}`);
    }
    console.log(`closed ${targets.length}`);
    return;
  }

  if (command === "quit") {
    const response = await fetch(`http://${HOST}/json/version`);
    const { webSocketDebuggerUrl } = await response.json();
    const session = new Session(webSocketDebuggerUrl);
    await session.send("Browser.close");
    console.log("chrome closed");
    return;
  }

  if (command === "resize") {
    const width = Number(args[0]);
    const height = Number(args[1]);
    if (!width || !height) fail("Usage: node browser.mjs resize <width> <height> [left] [top]");
    const target = await pickTarget();
    const response = await fetch(`http://${HOST}/json/version`);
    const { webSocketDebuggerUrl } = await response.json();
    const browser = new Session(webSocketDebuggerUrl);
    const { windowId } = await browser.send("Browser.getWindowForTarget", {
      targetId: target.id,
    });
    const bounds = { width, height, windowState: "normal" };
    if (args[2] !== undefined) bounds.left = Number(args[2]);
    if (args[3] !== undefined) bounds.top = Number(args[3]);
    await browser.send("Browser.setWindowBounds", { windowId, bounds });
    browser.close();
    console.log(`window ${width}x${height}`);
    return;
  }

  const target = await pickTarget();
  const session = await connect(target);

  try {
    if (command === "text") {
      const pattern = args[0];
      const text = await evaluate(session, "document.body ? document.body.innerText : ''");
      if (!pattern) {
        console.log(text);
        return;
      }
      const needle = pattern.toLowerCase();
      const matches = text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle));
      console.log(matches.length ? matches.join("\n") : `(no line matching "${pattern}")`);
      return;
    }

    if (command === "eval") {
      const expression = args.join(" ");
      if (!expression) fail("Usage: node browser.mjs eval \"<js expression>\"");
      const value = await evaluate(session, expression);
      console.log(
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      );
      return;
    }

    if (command === "click") {
      const selector = args[0];
      if (!selector) fail("Usage: node browser.mjs click <selector>");
      const value = await evaluate(
        session,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return "NOT_FOUND";
          el.scrollIntoView({ block: "center" });
          el.click();
          return "OK:" + (el.innerText || el.value || el.tagName).slice(0, 80);
        })()`,
      );
      console.log(value);
      return;
    }

    if (command === "tap") {
      const label = args.join(" ");
      if (!label) fail("Usage: node browser.mjs tap <visible text>");
      const value = await evaluate(
        session,
        `(() => {
          const label = ${JSON.stringify(label)};
          const candidates = [...document.querySelectorAll("*")].filter((el) => {
            if (el.children.length > 0) return false;
            return el.textContent.trim() === label;
          });
          if (candidates.length === 0) return "NOT_FOUND";
          const scored = candidates
            .map((el) => ({ el, rect: el.getBoundingClientRect() }))
            .filter((c) => c.rect.width > 0 && c.rect.height > 0)
            .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
          const target = scored[0] || { el: candidates[0], rect: candidates[0].getBoundingClientRect() };
          const { x, y, width, height } = target.rect;
          const hit = document.elementFromPoint(x + width / 2, y + height / 2) || target.el;
          hit.click();
          return "OK " + hit.tagName + " @ " + Math.round(x + width / 2) + "," + Math.round(y + height / 2);
        })()`,
      );
      console.log(value);
      return;
    }

    if (command === "fill") {
      const [selector, ...rest] = args;
      const value = rest.join(" ");
      if (!selector) fail("Usage: node browser.mjs fill <selector> <value>");
      const result = await evaluate(
        session,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return "NOT_FOUND";
          const setter = Object.getOwnPropertyDescriptor(
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype,
            "value",
          ).set;
          setter.call(el, ${JSON.stringify(value)});
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return "OK";
        })()`,
      );
      console.log(result);
      return;
    }

    if (command === "shot") {
      const path = args[0];
      if (!path) fail("Usage: node browser.mjs shot <path> [full]");
      const full = args[1] === "full";
      const { data } = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: full,
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, Buffer.from(data, "base64"));
      console.log(path);
      return;
    }

    if (command === "close") {
      await session.send("Page.close");
      return;
    }

    fail(`Unknown command: ${command}`);
  } finally {
    session.close();
  }
}

main().catch((error) => fail(error.stack || String(error)));
