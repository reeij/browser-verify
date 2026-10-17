#!/usr/bin/env node
/**
 * Persistent Chrome DevTools Protocol session.
 *
 * Keeps one attached page session alive. By default the page uses the real
 * window size; mobile emulation is opt-in. Exposes a tiny local HTTP API on
 * 127.0.0.1:9334.
 *
 *   GET  /health          -> { ok, targetId, url, viewport }
 *   POST /cdp             -> { method, params } forwarded to the attached page
 *   POST /target          -> { targetId } re-attach to another page
 *   POST /viewport        -> { width, height, mobile } change emulation
 *                            (send no width/height to fill the real window)
 */

import { createServer } from "node:http";

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CDP_HOST = `127.0.0.1:${CDP_PORT}`;
const LISTEN_PORT = Number(process.env.BROWSERD_PORT || 9334);

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Default: no device emulation, so the content viewport follows the real
// window and fills it. Set BROWSERD_WIDTH/BROWSERD_HEIGHT (and optionally
// BROWSERD_MOBILE=1) to opt into an emulated viewport.
const explicitlyEmulated =
  process.env.BROWSERD_WIDTH != null ||
  process.env.BROWSERD_HEIGHT != null ||
  process.env.BROWSERD_MOBILE === "1";

let viewport = explicitlyEmulated
  ? {
      width: Number(process.env.BROWSERD_WIDTH || 390),
      height: Number(process.env.BROWSERD_HEIGHT || 844),
      mobile: process.env.BROWSERD_MOBILE === "1",
    }
  : null;

let socket;
let nextId = 1;
const pending = new Map();
let sessionId = null;
let targetId = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function send(method, params = {}, useSession = true) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) {
      return reject(new Error("Chrome DevTools socket is not connected"));
    }
    const id = nextId++;
    const message = { id, method, params };
    if (useSession && sessionId) message.sessionId = sessionId;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify(message));
  });
}

async function listPages() {
  const response = await fetch(`http://${CDP_HOST}/json/list`);
  const targets = await response.json();
  return targets.filter((t) => t.type === "page");
}

async function applyViewport() {
  if (!viewport) {
    await send("Emulation.clearDeviceMetricsOverride");
    await send("Emulation.setUserAgentOverride", { userAgent: "" });
    return;
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.mobile ? 3 : 1,
    mobile: viewport.mobile,
  });
  await send("Emulation.setUserAgentOverride", {
    userAgent: viewport.mobile ? MOBILE_UA : "",
  });
}

async function attach(id) {
  const { sessionId: newSession } = await send(
    "Target.attachToTarget",
    { targetId: id, flatten: true },
    false,
  );
  sessionId = newSession;
  targetId = id;
  await send("Page.enable");
  await send("Runtime.enable");
  await applyViewport();
  log("attached", id);
}

async function attachFirstPage() {
  const pages = await listPages();
  if (pages.length === 0) {
    const created = await fetch(`http://${CDP_HOST}/json/new?about:blank`, {
      method: "PUT",
    });
    const target = await created.json();
    await attach(target.id);
    return;
  }
  await attach(pages[0].id);
}

function connect() {
  return fetch(`http://${CDP_HOST}/json/version`)
    .then((response) => response.json())
    .then(({ webSocketDebuggerUrl }) => {
      socket = new WebSocket(webSocketDebuggerUrl);
      socket.addEventListener("open", async () => {
        log("connected to chrome");
        try {
          await attachFirstPage();
        } catch (error) {
          log("attach failed:", error.message);
        }
      });
      socket.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
          return;
        }
        if (message.method === "Target.targetDestroyed" && message.params.targetId === targetId) {
          log("attached target closed, re-attaching");
          sessionId = null;
          targetId = null;
          setTimeout(() => attachFirstPage().catch((e) => log("reattach failed", e.message)), 500);
        }
      });
      socket.addEventListener("close", () => {
        log("socket closed, retrying in 2s");
        sessionId = null;
        targetId = null;
        setTimeout(connect, 2000);
      });
    })
    .catch((error) => {
      log("cannot reach chrome:", error.message, "- retrying in 2s");
      setTimeout(connect, 2000);
    });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) reject(new Error("body too large"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = createServer(async (request, response) => {
  const reply = (status, payload) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  try {
    if (request.method === "GET" && request.url === "/health") {
      let url = null;
      try {
        const result = await send("Runtime.evaluate", {
          expression: "location.href",
          returnByValue: true,
        });
        url = result?.result?.value ?? null;
      } catch {
        /* target may be mid-navigation */
      }
      return reply(200, { ok: Boolean(sessionId), targetId, url, viewport });
    }

    if (request.method === "POST" && request.url === "/cdp") {
      const { method, params } = await readBody(request);
      if (!method) return reply(400, { error: "method required" });
      const result = await send(method, params || {});
      return reply(200, { result });
    }

    if (request.method === "POST" && request.url === "/target") {
      const { targetId: wanted } = await readBody(request);
      await attach(wanted);
      return reply(200, { ok: true, targetId });
    }

    if (request.method === "POST" && request.url === "/viewport") {
      const body = await readBody(request);
      if (body.width == null && body.height == null && body.mobile == null) {
        viewport = null;
      } else {
        viewport = {
          width: Number(body.width ?? viewport?.width ?? 390),
          height: Number(body.height ?? viewport?.height ?? 844),
          mobile: Boolean(body.mobile ?? viewport?.mobile ?? false),
        };
      }
      await applyViewport();
      return reply(200, { ok: true, viewport });
    }

    return reply(404, { error: "not found" });
  } catch (error) {
    return reply(500, { error: error.message });
  }
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  log(`browserd listening on 127.0.0.1:${LISTEN_PORT}`);
  connect();
});
