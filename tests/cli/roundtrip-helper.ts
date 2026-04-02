import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runCli } from "../utils.js";
import { patchSchemaMetadataColumn } from "../db-patch.js";

const ENV_OVERRIDES = {
  // Clear remote mode so the CLI uses local SQLite in the temp dir.
  // Bun auto-loads .env which may set RELEASED_API_URL.
  RELEASED_API_URL: "",
  RELEASED_API_KEY: "",
};

export function createTempDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "released-roundtrip-"));

  // --help triggers auto-migration (runMigrations() runs before program.parse())
  runCli(["--help"], { env: { ...ENV_OVERRIDES, RELEASED_DATA_DIR: dataDir } });

  // Patch schema drift — remove once a proper migration is added
  const sqlite = new Database(join(dataDir, "released.db"));
  patchSchemaMetadataColumn(sqlite);
  sqlite.close();

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
    env: { ...ENV_OVERRIDES, RELEASED_DATA_DIR: dataDir },
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
