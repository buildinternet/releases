import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli } from "../utils.js";

// runCli() in tests/utils.ts already clears RELEASED_API_URL and
// RELEASED_API_KEY, so we only need the data-dir override here.

export function createTempDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "released-roundtrip-"));

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
export function cliJson<T = unknown>(
  dataDir: string,
  args: string[],
): T {
  const result = cli(dataDir, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `CLI exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}
