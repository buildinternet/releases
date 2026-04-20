import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { Hono } from "hono";
import { statusRoutes } from "../../workers/api/src/routes/status";

export function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

export function mkApp(db: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).env = { DB: db };
    await next();
  });
  app.route("/v1", statusRoutes);
  return app;
}
