#!/usr/bin/env node
/**
 * Cross-platform helper for the background browserd process.
 *
 *   node daemon.mjs start    start browserd detached
 *   node daemon.mjs stop     stop the process recorded in the pid file
 *   node daemon.mjs status   print daemon health
 *
 * Works on macOS, Linux, and Windows: the daemon is spawned with Node's
 * detached child process support instead of launchctl.
 *
 * Environment:
 *   BROWSERD_PORT    daemon port (default 9334)
 *   BROWSERD_URL     full daemon URL, used for health checks
 *   BROWSERD_WIDTH   optional emulated viewport width
 *   BROWSERD_HEIGHT  optional emulated viewport height
 *   BROWSERD_MOBILE  set to 1 for mobile emulation
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.BROWSERD_PORT || 9334);
const BASE_URL = process.env.BROWSERD_URL || `http://127.0.0.1:${PORT}`;
const PID_FILE = join(tmpdir(), "claude-browserd.pid");
const LOG_FILE = join(tmpdir(), "claude-browserd.log");
const DAEMON_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "browserd.mjs");

async function health() {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

async function start() {
  if (await health()) {
    console.log(`browserd already running on ${BASE_URL}`);
    return;
  }

  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  closeSync(log);
  await writeFile(PID_FILE, String(child.pid), "utf8");

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await health()) {
      console.log(`browserd started (pid ${child.pid}) on ${BASE_URL}`);
      console.log(`log: ${LOG_FILE}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  console.error(`browserd did not become healthy within 10s (pid ${child.pid})`);
  console.error(`log: ${LOG_FILE}`);
  process.exitCode = 1;
}

async function stop() {
  let pid = null;
  try {
    pid = Number((await readFile(PID_FILE, "utf8")).trim());
  } catch {
    /* no pid file */
  }

  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    console.log("browserd is not running (no pid file)");
    await rm(PID_FILE, { force: true });
    return;
  }

  try {
    process.kill(pid);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await rm(PID_FILE, { force: true });
  console.log(`browserd stopped (pid ${pid})`);
}

async function status() {
  const running = await health();
  if (!running) {
    console.log(`browserd is not running on ${BASE_URL}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(running, null, 2));
}

const action = process.argv[2];
const actions = { start, stop, status };

if (!action || !actions[action]) {
  console.error("Usage: node daemon.mjs <start|stop|status>");
  process.exit(1);
}

actions[action]().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
