// All logging goes to stderr — stdout is reserved for MCP JSON-RPC in serve mode
// Logs are also persisted to ~/.releases/logs/ for debugging

import { appendFileSync } from "fs";
import { join } from "path";
import { getLogsDir } from "./config.js";

function getLogFile(): string {
  const date = new Date().toISOString().split("T")[0];
  return join(getLogsDir(), `${date}.log`);
}

function writeToFile(level: string, args: unknown[]) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ");
  appendFileSync(getLogFile(), `${timestamp} [${level}] ${message}\n`);
}

export const logger = {
  info: (...args: unknown[]) => {
    console.error("[releases]", ...args);
    writeToFile("INFO", args);
  },
  warn: (...args: unknown[]) => {
    console.error("[releases] WARN:", ...args);
    writeToFile("WARN", args);
  },
  error: (...args: unknown[]) => {
    console.error("[releases] ERROR:", ...args);
    writeToFile("ERROR", args);
  },
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.error("[releases] DEBUG:", ...args);
    writeToFile("DEBUG", args);
  },
};
