#!/usr/bin/env bun
/**
 * One-shot backfill: set is_hidden=1 on existing on-demand orgs that predate
 * the #1603 fix. Before the fix, POST /v1/lookups materialised org rows with
 * is_hidden=0 (the default). This script finds them and marks them hidden so
 * they stop appearing in the sitemap and public listings.
 *
 * Dry-run (default — prints affected slugs without writing):
 *   bun scripts/backfill-on-demand-org-hidden.ts
 *
 * Apply:
 *   bun scripts/backfill-on-demand-org-hidden.ts --apply
 *
 * Remote (prod / staging — requires RELEASES_API_URL + RELEASES_API_KEY):
 *   RELEASES_API_URL=https://api.releases.sh bun scripts/backfill-on-demand-org-hidden.ts
 *   RELEASES_API_URL=https://api.releases.sh bun scripts/backfill-on-demand-org-hidden.ts --apply
 */

const apply = process.argv.includes("--apply");

async function main() {
  const apiUrl = (process.env.RELEASES_API_URL ?? process.env.RELEASED_API_URL)?.replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.RELEASES_API_KEY ?? process.env.RELEASED_API_KEY;

  if (!apiUrl || !apiKey) {
    console.error(
      "Set RELEASES_API_URL and RELEASES_API_KEY (static root key) before running.\n" +
        "For local dev, source .env or set them inline.",
    );
    process.exit(1);
  }

  // Fetch every org from the admin orgs list and filter client-side, since the
  // public /v1/orgs catalog only returns non-on-demand rows. Use the admin
  // list endpoint which surfaces all discovery values.
  console.log(`Fetching orgs from ${apiUrl} …`);
  const res = await fetch(`${apiUrl}/v1/orgs?limit=500`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error(`GET /v1/orgs failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const body = (await res.json()) as {
    orgs: Array<{ id: string; slug: string; discovery?: string; isHidden?: boolean }>;
  };
  const targets = body.orgs.filter((o) => o.discovery === "on_demand" && o.isHidden !== true);

  if (targets.length === 0) {
    console.log("No on-demand orgs with is_hidden=false found — nothing to do.");
    return;
  }

  console.log(
    `Found ${targets.length} on-demand org(s) with is_hidden=false:`,
    targets.map((o) => o.slug),
  );

  if (!apply) {
    console.log("\nDry-run. Pass --apply to write changes.");
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const org of targets) {
    const patch = await fetch(`${apiUrl}/v1/orgs/${org.slug}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isHidden: true }),
    });
    if (patch.ok) {
      console.log(`  ✓ ${org.slug} (${org.id}) → is_hidden=true`);
      updated++;
    } else {
      const err = await patch.text();
      console.error(`  ✗ ${org.slug}: ${patch.status} ${err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${updated} updated, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
