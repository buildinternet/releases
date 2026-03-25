#!/usr/bin/env bun
import { program } from "./cli/program.js";
import { runMigrations } from "./db/migrate.js";

runMigrations();
program.parse();
