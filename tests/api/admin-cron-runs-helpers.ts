import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { adminCronRunsRoutes } from "../../workers/api/src/routes/admin-cron-runs";

export function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return db;
}

export function mkApp(db: any) {
  const app = new Hono();
  app.use("*", async (c, next) => { (c as any).set("db", db); await next(); });
  app.route("/", adminCronRunsRoutes);
  return app;
}
