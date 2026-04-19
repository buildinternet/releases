import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli } from "../utils.js";
import { stripAnsi } from "../../src/lib/sanitize.js";

const CLI_PATH = join(import.meta.dirname, "..", "..", "src", "index.ts");

// runCli() in tests/utils.ts already clears RELEASED_API_URL and
// RELEASED_API_KEY, so we only need the data-dir override here.

export function createTempDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "releases-roundtrip-"));

  // --help triggers auto-migration (runMigrations() runs before program.parse())
  runCli(["--help"], { env: { RELEASED_DATA_DIR: dataDir } });

  return {
    dataDir,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

export function cli(
  dataDir: string,
  args: string[],
  options?: { timeout?: number },
): ReturnType<typeof runCli> {
  return runCli(args, {
    env: { RELEASED_DATA_DIR: dataDir },
    timeout: options?.timeout,
  });
}

/** Throws if exit code is non-zero. */
export function cliJson<T = unknown>(dataDir: string, args: string[]): T {
  const result = cli(dataDir, args);
  if (result.exitCode !== 0) {
    throw new Error(`CLI exited with code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as T;
}

/**
 * Async CLI runner that doesn't block the event loop.
 * Use this when an in-process Bun.serve fixture server must stay responsive
 * during CLI execution (spawnSync would deadlock it).
 */
export async function cliAsync(
  dataDir: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: {
      ...process.env,
      RELEASED_DATA_DIR: dataDir,
      RELEASED_API_URL: "",
      RELEASED_API_KEY: "test",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutMs = options?.timeout ?? 30_000;
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`CLI timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  await Promise.race([proc.exited, timer]);

  const stdout = stripAnsi(await new Response(proc.stdout).text());
  const stderr = stripAnsi(await new Response(proc.stderr).text());

  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}
