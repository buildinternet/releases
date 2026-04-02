import { drizzle } from "drizzle-orm/d1";
import * as schema from "@released/db/schema.js";

export type D1Db = ReturnType<typeof createDb>;

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
