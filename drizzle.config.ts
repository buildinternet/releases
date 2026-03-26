import { defineConfig } from "drizzle-kit";
import { homedir } from "os";
import { join } from "path";

const dataDir = process.env.RELEASED_DATA_DIR || join(homedir(), ".released");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: join(dataDir, "released.db"),
  },
});
