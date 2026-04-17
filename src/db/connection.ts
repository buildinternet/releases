import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getDbPath } from "@releases/lib/config";
import { isRemoteMode } from "../lib/mode.js";
import * as schema from "@buildinternet/releases-core/schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (isRemoteMode()) {
    throw new Error("getDb() called in remote mode — use API client instead");
  }
  if (!_db) {
    const sqlite = new Database(getDbPath());
    sqlite.run("PRAGMA journal_mode=WAL");
    sqlite.run("PRAGMA foreign_keys=ON");
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}
