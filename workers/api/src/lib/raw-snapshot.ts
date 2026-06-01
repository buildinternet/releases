import { sha256Hex } from "@releases/core-internal/hash";
import { sourceRawSnapshots } from "@buildinternet/releases-core/schema";
import type { createDb } from "../db.js";

interface R2Like {
  put(key: string, value: ArrayBuffer | string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<unknown | null>;
}

export type RawFormat = "markdown" | "html";

const EXT: Record<RawFormat, string> = { markdown: "md", html: "html" };

export async function saveRawSnapshot(
  deps: { R2: R2Like; db: ReturnType<typeof createDb> },
  input: { sourceId: string; body: string; format: RawFormat },
): Promise<{ r2Key: string; contentHash: string; bytes: number; created: boolean }> {
  const hash = sha256Hex(input.body);
  const r2Key = `sources/${input.sourceId}/raw/${hash}.${EXT[input.format]}`;
  const bytes = new TextEncoder().encode(input.body).length;

  // Only upload to R2 if not already there (content-addressed dedup)
  if (!(await deps.R2.head(r2Key))) {
    await deps.R2.put(r2Key, input.body);
  }

  // Insert the D1 pointer row, deduped at the DB on the
  // `uq_raw_snapshots_source_hash` (source_id, content_hash) unique index:
  // `onConflictDoNothing` absorbs a concurrent save of the same body (e.g. two
  // backfills on one source) instead of throwing. `created` is derived from the
  // RETURNING rows — empty on a conflict no-op — so it's correct under that race
  // (a pre-insert read would let both racers report `created: true`). The
  // raw-snapshot route surfaces this as `stored`.
  const insertedRows = await deps.db
    .insert(sourceRawSnapshots)
    .values({
      sourceId: input.sourceId,
      r2Key,
      contentHash: hash,
      format: input.format,
      bytes,
    })
    .onConflictDoNothing()
    .returning({ id: sourceRawSnapshots.id });

  return { r2Key, contentHash: hash, bytes, created: insertedRows.length > 0 };
}

export async function loadRawSnapshot(deps: { R2: R2Like }, r2Key: string): Promise<string | null> {
  const obj = await deps.R2.get(r2Key);
  return obj ? obj.text() : null;
}
