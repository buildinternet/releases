#!/usr/bin/env bun
// One-time: export the live self-changelog rollups into CHANGELOG.md.
// Usage: RELEASES_API_KEY=... bun scripts/changelog/export-existing.ts
import { writeFileSync } from "node:fs";
import { renderChangelog, type ChangelogReleaseInput } from "./changelog-md";

const SOURCE_ID = "src_LNrMz-rrFa2OD27mBUfaT";
const BASE = process.env.RELEASES_API_URL ?? "https://api.releases.sh";
const KEY = process.env.RELEASES_API_KEY ?? process.env.RELEASED_API_KEY;
if (!KEY) {
  console.error("Set RELEASES_API_KEY (or RELEASED_API_KEY).");
  process.exit(1);
}

const res = await fetch(`${BASE}/v1/sources/${SOURCE_ID}/releases?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
if (!res.ok) {
  console.error(`GET releases → HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { releases } = (await res.json()) as { releases: { publishedAt: string; content: string }[] };
const entries: ChangelogReleaseInput[] = releases.map((r) => ({
  dateIso: (r.publishedAt ?? "").slice(0, 10),
  body: r.content ?? "",
}));
writeFileSync("CHANGELOG.md", renderChangelog(entries));
console.log(`Wrote CHANGELOG.md with ${entries.length} entries.`);
