// In Node/Bun (CLI): all logging goes to stderr (stdout is reserved for MCP
// JSON-RPC in serve mode) and is persisted to ~/.releases/logs/ for debugging.
// In Cloudflare Workers and Workflows: dispatch to the matching `console.*`
// method so Workers Logs reads the right severity, and skip the FS write
// (the virtual FS is discarded per-request and `console.error` for everything
// would tag `info` lines as ERROR-level — see issue #713).

import { appendFileSync } from "fs";
import { join } from "path";
import { getLogsDir } from "./config.js";

/**
 * True inside a Worker or Workflow isolate.
 *
 * `navigator.userAgent === "Cloudflare-Workers"` is the documented signal, but
 * it is missing on Workflow entrypoints and `nodejs_compat` can shadow
 * `navigator` with Node's. `caches.default` is the Workers Cache API — present
 * in both of those isolates, and absent in Node and Bun (browsers have
 * `caches` without `.default`). Read at call time: a module-level snapshot is
 * taken before the workflow isolate installs its globals.
 */
function inCloudflareRuntime(): boolean {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (ua === "Cloudflare-Workers") return true;
  const cachesGlobal = (globalThis as { caches?: { default?: unknown } }).caches;
  return cachesGlobal?.default !== undefined;
}

function getLogFile(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(getLogsDir(), `${date}.log`);
}

function writeToFile(level: string, args: unknown[]) {
  if (inCloudflareRuntime()) return;
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  appendFileSync(getLogFile(), `${timestamp} [${level}] ${message}\n`);
}

export const logger = {
  info: (...args: unknown[]) => {
    if (inCloudflareRuntime()) console.log("[releases]", ...args);
    else console.error("[releases]", ...args);
    writeToFile("INFO", args);
  },
  warn: (...args: unknown[]) => {
    console.warn("[releases] WARN:", ...args);
    writeToFile("WARN", args);
  },
  error: (...args: unknown[]) => {
    console.error("[releases] ERROR:", ...args);
    writeToFile("ERROR", args);
  },
  debug: (...args: unknown[]) => {
    if (inCloudflareRuntime()) {
      console.debug("[releases] DEBUG:", ...args);
    } else if (process.env.DEBUG) {
      console.error("[releases] DEBUG:", ...args);
    }
    writeToFile("DEBUG", args);
  },
};
