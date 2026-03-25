import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getDbPath } from "../lib/config.js";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    const sqlite = new Database(getDbPath());
    sqlite.run("PRAGMA journal_mode=WAL");
    sqlite.run("PRAGMA foreign_keys=ON");
    _db = drizzle(sqlite, { schema });
  }
  return _db;
}
