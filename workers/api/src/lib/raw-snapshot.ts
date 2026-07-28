import { and, eq } from "drizzle-orm";
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
): Promise<{
  /** `sourceRawSnapshots.id` — the handle `reextract-source` takes as `snapshotId`. */
  id: string | null;
  r2Key: string;
  contentHash: string;
  bytes: number;
  created: boolean;
}> {
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

  // `onConflictDoNothing` returns no rows when the body was already stored, but
  // callers still need the snapshot id — it is what `reextract-source` takes as
  // `snapshotId`, and a replay is just as valid against a pre-existing snapshot
  // as a fresh one. Re-read on the conflict path only, so the happy path stays a
  // single statement.
  //
  // Return the EXISTING row's metadata wholesale rather than pairing its id with
  // our locally-derived `r2Key`: the unique index is (source_id, content_hash)
  // and excludes `format`, so saving a markdown body that already exists as HTML
  // conflicts against the HTML row. Mixing that row's id with the `.md` key we
  // just computed would hand a caller an id and a key describing different
  // objects, and a replay would silently read the wrong one.
  const inserted = insertedRows[0];
  if (!inserted) {
    const [existing] = await deps.db
      .select({
        id: sourceRawSnapshots.id,
        r2Key: sourceRawSnapshots.r2Key,
        contentHash: sourceRawSnapshots.contentHash,
        bytes: sourceRawSnapshots.bytes,
      })
      .from(sourceRawSnapshots)
      .where(
        and(
          eq(sourceRawSnapshots.sourceId, input.sourceId),
          eq(sourceRawSnapshots.contentHash, hash),
        ),
      )
      .limit(1);
    if (existing) return { ...existing, created: false };
  }

  return { id: inserted?.id ?? null, r2Key, contentHash: hash, bytes, created: inserted != null };
}

export async function loadRawSnapshot(deps: { R2: R2Like }, r2Key: string): Promise<string | null> {
  const obj = await deps.R2.get(r2Key);
  return obj ? obj.text() : null;
}
