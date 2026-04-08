#!/usr/bin/env bun
import { program } from "./cli/program.js";
import { runMigrations } from "./db/migrate.js";
import { isRemoteMode, validateRemoteMode } from "./lib/mode.js";

validateRemoteMode();

if (!isRemoteMode()) {
  runMigrations();
}

program.parse();
