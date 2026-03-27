import { defineConfig } from "drizzle-kit";
import { dirname, join } from "path";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";

// Find the D1 SQLite file in wrangler's local state
const __dirname = dirname(fileURLToPath(import.meta.url));
const d1Dir = join(
  __dirname,
  "workers/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"
);

const noDbMessage =
  "No local D1 database found. Run `bun run db:migrate:local` first.";

let dbPath: string;
try {
  const files = readdirSync(d1Dir).filter((f: string) => f.endsWith(".sqlite"));
  if (files.length === 0) throw new Error(noDbMessage);
  dbPath = join(d1Dir, files[0]);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(noDbMessage);
  throw e;
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: dbPath,
  },
});
