import { Database } from "bun:sqlite";

/**
 * organizations.metadata exists in schema.ts but has no migration yet.
 * Add the column if missing so queries match the schema.
 * Remove this once a proper migration is added.
 */
export function patchSchemaMetadataColumn(sqlite: Database): void {
  const cols = sqlite
    .prepare("PRAGMA table_info(organizations)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "metadata")) {
    sqlite.run("ALTER TABLE organizations ADD COLUMN metadata TEXT DEFAULT '{}'");
  }
}
