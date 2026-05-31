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
): Promise<{ r2Key: string; contentHash: string; bytes: number }> {
  const hash = sha256Hex(input.body);
  const r2Key = `sources/${input.sourceId}/raw/${hash}.${EXT[input.format]}`;
  const bytes = new TextEncoder().encode(input.body).length;

  // Only upload to R2 if not already there (content-addressed dedup)
  if (!(await deps.R2.head(r2Key))) {
    await deps.R2.put(r2Key, input.body);
  }

  // Only insert a D1 pointer row if one doesn't exist for (sourceId, contentHash)
  const existing = await deps.db
    .select({ id: sourceRawSnapshots.id })
    .from(sourceRawSnapshots)
    .where(
      and(
        eq(sourceRawSnapshots.sourceId, input.sourceId),
        eq(sourceRawSnapshots.contentHash, hash),
      ),
    );

  if (existing.length === 0) {
    // `onConflictDoNothing` closes the select→insert race: a concurrent save of
    // the same (sourceId, contentHash) — e.g. two backfills on one source — hits
    // the `uq_raw_snapshots_source_hash` unique index and is silently absorbed
    // instead of throwing. The return values are derived locally, so a conflict
    // needs no re-query.
    await deps.db
      .insert(sourceRawSnapshots)
      .values({
        sourceId: input.sourceId,
        r2Key,
        contentHash: hash,
        format: input.format,
        bytes,
      })
      .onConflictDoNothing();
  }

  return { r2Key, contentHash: hash, bytes };
}

export async function loadRawSnapshot(deps: { R2: R2Like }, r2Key: string): Promise<string | null> {
  const obj = await deps.R2.get(r2Key);
  return obj ? obj.text() : null;
}
