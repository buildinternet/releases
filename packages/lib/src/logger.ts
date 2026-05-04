// In Node/Bun (CLI): all logging goes to stderr (stdout is reserved for MCP
// JSON-RPC in serve mode) and is persisted to ~/.releases/logs/ for debugging.
// In Cloudflare Workers: dispatch to the matching `console.*` method so
// Workers Logs reads the right severity, and skip the FS write (the virtual
// FS is discarded per-request and `console.error` for everything would tag
// `info` lines as ERROR-level — see issue #713).

import { appendFileSync } from "fs";
import { join } from "path";
import { getLogsDir } from "./config.js";

const isWorker =
  typeof navigator !== "undefined" &&
  (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers";

function getLogFile(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(getLogsDir(), `${date}.log`);
}

function writeToFile(level: string, args: unknown[]) {
  if (isWorker) return;
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  appendFileSync(getLogFile(), `${timestamp} [${level}] ${message}\n`);
}

export const logger = {
  info: (...args: unknown[]) => {
    if (isWorker) console.log("[releases]", ...args);
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
    if (isWorker) {
      console.debug("[releases] DEBUG:", ...args);
    } else if (process.env.DEBUG) {
      console.error("[releases] DEBUG:", ...args);
    }
    writeToFile("DEBUG", args);
  },
};
