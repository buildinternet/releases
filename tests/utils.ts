import { spawnSync } from "child_process";
import { join } from "path";
import { stripAnsi } from "../src/lib/sanitize.js";

const CLI_PATH = join(import.meta.dirname, "..", "src", "index.ts");

export function runCli(
  args: string[],
  options?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
  // Always clear remote-mode env vars so tests use local SQLite by default.
  // Bun auto-loads .env which may set RELEASED_API_URL, causing tests to
  // route through the remote API. Callers can still override explicitly.
  const safeEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    RELEASED_API_URL: "",
    RELEASED_API_KEY: "",
    ...options?.env,
  };
  const result = spawnSync("bun", [CLI_PATH, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: safeEnv,
    timeout: options?.timeout ?? 30_000,
  });
  return {
    stdout: stripAnsi(result.stdout ?? ""),
    stderr: stripAnsi(result.stderr ?? ""),
    exitCode: result.status ?? 1,
  };
}
