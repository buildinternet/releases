// scripts/seed-d1.ts
//
// One-time script to seed the remote D1 database from the local SQLite database.
// Usage: SEED_API_URL=http://localhost:8787 SEED_API_KEY=<secret> bun scripts/seed-d1.ts
//
// Uses SEED_API_URL / SEED_API_KEY (not RELEASED_API_URL) to avoid triggering
// remote mode detection in getDb(), which reads RELEASED_API_URL.

import { getDb } from "../src/db/connection.js";
import { organizations, orgAccounts, sources, releases, ignoredUrls } from "../src/db/schema.js";

const API_URL = process.env.SEED_API_URL;
const API_KEY = process.env.SEED_API_KEY;

if (!API_URL || !API_KEY) {
  console.error("Set SEED_API_URL and SEED_API_KEY");
  process.exit(1);
}

const CONCURRENCY = 10;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

const db = getDb();

// 1. Seed organizations
const orgs = await db.select().from(organizations);
console.log(`Seeding ${orgs.length} organizations...`);
for (const org of orgs) {
  const res = await post("/v1/orgs", { name: org.name, slug: org.slug, domain: org.domain });
  if (res.ok || res.status === 409) {
    console.log(`  ✓ ${org.slug}`);
  } else {
    console.error(`  ✗ ${org.slug}: ${res.status} ${await res.text()}`);
  }
}

// Build lookup maps for O(1) access in later steps
const orgById = new Map(orgs.map((o) => [o.id, o]));
const srcById = new Map<string, { slug: string }>();

// 2. Seed org accounts
const accounts = await db.select().from(orgAccounts);
console.log(`\nSeeding ${accounts.length} org accounts...`);
for (const acc of accounts) {
  const org = orgById.get(acc.orgId);
  if (!org) continue;
  const res = await post(`/v1/orgs/${org.slug}/accounts`, { platform: acc.platform, handle: acc.handle });
  if (res.ok || res.status === 409) {
    console.log(`  ✓ ${acc.platform}/${acc.handle}`);
  } else {
    console.error(`  ✗ ${acc.platform}/${acc.handle}: ${res.status} ${await res.text()}`);
  }
}

// 3. Seed sources (use orgSlug instead of orgId to avoid ID mismatch)
const srcs = await db.select().from(sources);
console.log(`\nSeeding ${srcs.length} sources...`);
for (const src of srcs) {
  const org = src.orgId ? orgById.get(src.orgId) : null;
  const res = await post("/v1/sources", {
    name: src.name, slug: src.slug, type: src.type, url: src.url,
    orgSlug: org?.slug ?? undefined, metadata: src.metadata,
  });
  if (res.ok || res.status === 409) {
    console.log(`  ✓ ${src.slug}`);
  } else {
    console.error(`  ✗ ${src.slug}: ${res.status} ${await res.text()}`);
  }
  srcById.set(src.id, { slug: src.slug });
}

// 4. Seed releases (concurrent batches)
const allReleases = await db.select().from(releases);
console.log(`\nSeeding ${allReleases.length} releases (concurrency: ${CONCURRENCY})...`);
let seeded = 0;
let skipped = 0;
let errors = 0;

for (let i = 0; i < allReleases.length; i += CONCURRENCY) {
  const batch = allReleases.slice(i, i + CONCURRENCY);
  const results = await Promise.all(
    batch.map(async (rel) => {
      const src = srcById.get(rel.sourceId);
      if (!src) return "skip";
      const res = await post(`/v1/sources/${src.slug}/releases`, {
        id: rel.id, version: rel.version, title: rel.title, content: rel.content,
        contentSummary: rel.contentSummary, url: rel.url, contentHash: rel.contentHash,
        metadata: rel.metadata, publishedAt: rel.publishedAt, fetchedAt: rel.fetchedAt,
      });
      if (res.ok) return "seeded";
      if (res.status === 409) return "skipped";
      console.error(`  ✗ ${rel.id}: ${res.status}`);
      return "error";
    }),
  );
  for (const r of results) {
    if (r === "seeded") seeded++;
    else if (r === "skipped") skipped++;
    else if (r === "error") errors++;
  }
  const done = Math.min(i + CONCURRENCY, allReleases.length);
  if (done % 100 < CONCURRENCY || done === allReleases.length) {
    console.log(`  ${done}/${allReleases.length} (${seeded} new, ${skipped} existing${errors > 0 ? `, ${errors} errors` : ""})`);
  }
}
console.log(`  ✓ ${seeded} releases seeded, ${skipped} already existed`);

// 5. Seed ignored URLs
const ignored = await db.select().from(ignoredUrls);
console.log(`\nSeeding ${ignored.length} ignored URLs...`);
for (const ig of ignored) {
  const org = ig.orgId ? orgById.get(ig.orgId) : null;
  await post("/v1/ignore", { url: ig.url, orgId: org?.slug ?? undefined, reason: ig.reason });
}

console.log("\nDone!");
