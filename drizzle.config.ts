import { defineConfig } from "drizzle-kit";
import { homedir } from "os";
import { join } from "path";

const dataDir =
  process.env.RELEASES_DATA_DIR || process.env.RELEASED_DATA_DIR || join(homedir(), ".releases");

export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./packages/core/src/schema.ts",
    "./packages/core-internal/src/schema-coverage.ts",
    "./workers/api/src/db/schema-cron.ts",
  ],
  out: "./.drizzle-out",
  migrations: {
    prefix: "timestamp",
  },
  dbCredentials: {
    url: join(dataDir, "releases.db"),
  },
});
