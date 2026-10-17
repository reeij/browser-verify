#!/usr/bin/env node
/**
 * Launch Chrome with a throwaway profile and the DevTools port enabled.
 *
 *   node chrome.mjs
 *
 * Works on macOS, Windows, and Linux. The executable is detected from the
 * usual install locations; override it with CHROME_PATH. Override the profile
 * directory with CHROME_PROFILE.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE =
  process.env.CHROME_PROFILE || join(tmpdir(), "claude-browser-profile");

function absoluteCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

function chromeCommand() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const candidate of absoluteCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "chrome.exe" : "google-chrome";
}

async function cdpReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await cdpReady()) {
    console.log(`Chrome already listening on 127.0.0.1:${PORT}`);
    return;
  }

  const command = chromeCommand();
  const child = spawn(
    command,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await cdpReady()) {
      console.log(`Chrome started: ${command}`);
      console.log(`profile: ${PROFILE}`);
      console.log(`devtools: http://127.0.0.1:${PORT}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.error(`Chrome did not open the DevTools port within 15s: ${command}`);
  console.error("Set CHROME_PATH to the Chrome executable and retry.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
