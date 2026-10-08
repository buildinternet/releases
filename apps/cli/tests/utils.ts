import { spawnSync } from "child_process";
import { join } from "path";
import { stripAnsi } from "../src/lib/sanitize.js";

const CLI_PATH = join(import.meta.dirname, "..", "src", "index.ts");

const AMBIENT_RELEASES_ENV = new Set([
  "RELEASES_API_KEY",
  "RELEASES_API_URL",
  "RELEASES_API_TOKEN",
  "RELEASES_DATA_DIR",
]);

export function runCli(
  args: string[],
  options?: { env?: Record<string, string>; timeout?: number; input?: string },
): { stdout: string; stderr: string; exitCode: number } {
  // OSS CLI is remote-only — a real-looking URL must be set so the CLI starts.
  // Commands that don't hit the API (e.g. `categories`) succeed without it.
  // Drop the developer's real RELEASES_* env (API key/URL/token, data dir) so a
  // local run can't pick up ~/.releases or a shell-exported key — the canonical
  // names win over the RELEASED_* values set below and over a test's tmp
  // RELEASED_DATA_DIR. Tests that need one pass it via options.env.
  const inherited = Object.fromEntries(
    Object.entries(process.env as Record<string, string>).filter(
      ([k]) => !AMBIENT_RELEASES_ENV.has(k),
    ),
  );
  const safeEnv: Record<string, string> = {
    ...inherited,
    RELEASED_API_URL: "https://test.example.com",
    RELEASED_API_KEY: "test",
    ...options?.env,
  };
  // --no-env-file: bun autoloads `.env` from the cwd, and in the monorepo the
  // root `.env` carries real RELEASES_* credentials that would override the
  // scrubbed env above when the suite runs from the repo root.
  const result = spawnSync("bun", ["--no-env-file", CLI_PATH, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: safeEnv,
    timeout: options?.timeout ?? 30_000,
    input: options?.input,
  });
  return {
    stdout: stripAnsi(result.stdout ?? ""),
    stderr: stripAnsi(result.stderr ?? ""),
    exitCode: result.status ?? 1,
  };
}
