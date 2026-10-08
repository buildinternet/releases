#!/usr/bin/env bun
// One-off operator script: bulk-suppress releases listed as NDJSON on stdin.
// Each line: {"id": "rel_…", "reason": "…"}.
//
// Usage:
//   cat suppressions.ndjson | bun scripts/bulk-suppress.ts [--chunk 500]

import { batchSuppressReleases } from "../src/api/releases.ts";

const CHUNK = (() => {
  const idx = process.argv.indexOf("--chunk");
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0 && n <= 5000) return Math.floor(n);
  }
  return 500;
})();

const stdin = await new Response(Bun.stdin.stream()).text();
const rows = stdin
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as { id: string; reason?: string });

console.error(`Suppressing ${rows.length} releases (chunk=${CHUNK})…`);

const byReason = new Map<string | undefined, string[]>();
for (const row of rows) {
  const list = byReason.get(row.reason) ?? [];
  list.push(row.id);
  byReason.set(row.reason, list);
}

let updated = 0;
const errors: Array<{ ids: string[]; err: string }> = [];

for (const [reason, ids] of byReason) {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      // oxlint-disable-next-line no-await-in-loop -- bounded chunk writes under API bind budget
      const result = await batchSuppressReleases(slice, true, reason);
      updated += result.updated;
    } catch (err) {
      errors.push({
        ids: slice,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

console.error(`DONE. updated=${updated} requested=${rows.length} errors=${errors.length}`);
if (errors.length) {
  console.error("Errors (first chunk):");
  const e = errors[0];
  console.error(`  ${e.ids.length} ids: ${e.err}`);
}
process.exit(errors.length > 0 ? 1 : 0);
