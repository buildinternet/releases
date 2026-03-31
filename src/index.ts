#!/usr/bin/env bun
import { program } from "./cli/program.js";
import { runMigrations } from "./db/migrate.js";
import { isRemoteMode, validateRemoteMode } from "./lib/mode.js";

validateRemoteMode();

if (!isRemoteMode()) {
  try {
    runMigrations();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("_journal.json") || msg.includes("migrations")) {
      console.error(
        "Local mode is not supported in the compiled binary.\n" +
        "Set RELEASED_API_URL and RELEASED_API_KEY for remote mode,\n" +
        "or use `bun src/index.ts` for local development."
      );
    } else {
      console.error("Migration failed:", msg);
    }
    process.exit(1);
  }
}

program.parse();
