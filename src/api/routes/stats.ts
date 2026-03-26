import { count } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { organizations, sources, releases } from "../../db/schema.js";

export function handleStats() {
  const db = getDb();
  const [orgCount] = db.select({ n: count() }).from(organizations).all();
  const [sourceCount] = db.select({ n: count() }).from(sources).all();
  const [releaseCount] = db.select({ n: count() }).from(releases).all();
  return { orgs: orgCount.n, sources: sourceCount.n, releases: releaseCount.n };
}
