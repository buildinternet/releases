#!/usr/bin/env bun
/**
 * Populate org playbook `fetchQuirks` frontmatter from the change-detector
 * report at `.context/515-change-detectors.md` (#518 Phase 2 rollout prep).
 *
 * The upstream probe script already did the per-source classification work —
 * this step is purely mechanical:
 *
 *   1. Parse the report's per-source table to get (slug, class, rationale).
 *   2. Resolve each slug's owning org via `GET /v1/sources`.
 *   3. Group by org and merge into each org's playbook notes frontmatter via
 *      `parsePlaybookNotes` / `serializePlaybookNotes`. Existing entries for
 *      other source slugs are preserved.
 *   4. PATCH `/v1/orgs/:slug/playbook/notes` per org (single write per org
 *      even when multiple sources are being updated).
 *
 * Dry-run by default. `--apply` writes. Skip-by-slug with `--skip brex`.
 *
 * Usage:
 *   bun scripts/populate-fetch-quirks.ts                # dry run
 *   bun scripts/populate-fetch-quirks.ts --apply        # PATCH playbooks
 *   bun scripts/populate-fetch-quirks.ts --skip brex    # leave brex alone
 *   bun scripts/populate-fetch-quirks.ts --json         # machine-readable
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parsePlaybookNotes,
  serializePlaybookNotes,
  type FetchQuirk,
  type PlaybookFrontmatter,
} from "../packages/ai/src/playbook.js";

type DetectorClass = FetchQuirk["changeDetector"];

type ReportRow = {
  slug: string;
  detector: DetectorClass;
  rationale: string;
};

type SourceRow = {
  slug: string;
  name: string;
  orgSlug: string | null;
  orgName: string | null;
};

type OrgPlan = {
  orgSlug: string;
  orgName: string;
  entries: ReportRow[];
  priorFrontmatter: PlaybookFrontmatter | null;
  priorBody: string;
  priorQuirkCount: number;
  changes: Array<{ slug: string; from: DetectorClass | null; to: DetectorClass }>;
};

const REPORT_PATH = ".context/515-change-detectors.md";
const API_URL = process.env.RELEASED_API_URL ?? "https://api.releases.sh";
const API_KEY = process.env.RELEASED_API_KEY;

const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has("--apply");
const jsonOut = args.has("--json");
const skipSet = new Set<string>();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--skip" && argv[i + 1]) {
    skipSet.add(argv[i + 1]);
    i++;
  }
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** Parse the ".context/515-change-detectors.md" per-source table. */
function parseReport(markdown: string): ReportRow[] {
  // The table we want is the one under "## Per-source". Slice from that
  // header to the next `\n## ` (next h2) or end-of-file.
  const HEADER = "## Per-source";
  const start = markdown.indexOf(HEADER);
  if (start === -1) throw new Error("Per-source table not found in report");
  const rest = markdown.slice(start + HEADER.length);
  const nextHeader = rest.search(/\n## /);
  const section = nextHeader > -1 ? rest.slice(0, nextHeader) : rest;

  const rows: ReportRow[] = [];
  const lines = section.split("\n");
  const validClasses: ReadonlySet<DetectorClass> = new Set([
    "etag",
    "content-length",
    "body-hash",
    "unreliable",
  ]);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    // Skip header + separator (| Slug | ..., | --- | ---).
    if (/^\|\s*Slug\s*\|/i.test(line)) continue;
    if (/^\|\s*-+/.test(line)) continue;

    const cells = line
      .split("|")
      .slice(1, -1) // strip leading+trailing empty cells from the `|` borders
      .map((c) => c.trim());
    if (cells.length < 4) continue;

    const slug = cells[0].replace(/^`|`$/g, "");
    const detectorCell = cells[2].replace(/^`|`$/g, "") as DetectorClass;
    const rationale = cells[3].replace(/\\\|/g, "|").trim();
    if (!validClasses.has(detectorCell)) continue;

    rows.push({ slug, detector: detectorCell, rationale });
  }
  if (rows.length === 0) throw new Error("Per-source table matched but yielded zero rows");
  return rows;
}

async function listSources(): Promise<Map<string, SourceRow>> {
  const res = await fetch(`${API_URL}/v1/sources?limit=500`);
  if (!res.ok) throw new Error(`GET /v1/sources failed: ${res.status}`);
  const rows = (await res.json()) as Array<{
    slug: string;
    name: string;
    orgSlug: string | null;
    orgName: string | null;
  }>;
  const map = new Map<string, SourceRow>();
  for (const r of rows) {
    map.set(r.slug, {
      slug: r.slug,
      name: r.name,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
    });
  }
  return map;
}

async function getPlaybookNotes(orgSlug: string): Promise<string | null> {
  if (!API_KEY) throw new Error("RELEASED_API_KEY required to read playbooks");
  const res = await fetch(`${API_URL}/v1/orgs/${encodeURIComponent(orgSlug)}/playbook`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`GET playbook for ${orgSlug} failed: ${res.status}`);
  }
  const body = (await res.json()) as { notes?: string | null } | null;
  return body?.notes ?? null;
}

async function patchPlaybookNotes(orgSlug: string, notes: string): Promise<void> {
  if (!API_KEY) throw new Error("RELEASED_API_KEY required to --apply");
  const res = await fetch(`${API_URL}/v1/orgs/${encodeURIComponent(orgSlug)}/playbook/notes`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH playbook for ${orgSlug} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

/** Planning phase — pure, no writes. */
async function planUpdates(report: ReportRow[]): Promise<{
  plans: OrgPlan[];
  stranded: Array<{ slug: string; reason: string }>;
  skipped: ReportRow[];
}> {
  const sources = await listSources();
  const stranded: Array<{ slug: string; reason: string }> = [];
  const skipped: ReportRow[] = [];
  const byOrg = new Map<string, { orgName: string; entries: ReportRow[] }>();

  for (const row of report) {
    if (skipSet.has(row.slug)) {
      skipped.push(row);
      continue;
    }
    const src = sources.get(row.slug);
    if (!src) {
      stranded.push({ slug: row.slug, reason: "slug not found in /v1/sources" });
      continue;
    }
    if (!src.orgSlug || !src.orgName) {
      stranded.push({ slug: row.slug, reason: "source has no org" });
      continue;
    }
    const bucket = byOrg.get(src.orgSlug) ?? { orgName: src.orgName, entries: [] };
    bucket.entries.push(row);
    byOrg.set(src.orgSlug, bucket);
  }

  const plans: OrgPlan[] = [];
  for (const [orgSlug, bucket] of byOrg) {
    // oxlint-disable-next-line no-await-in-loop -- sequential: one GET per org, low volume
    const notes = await getPlaybookNotes(orgSlug);
    const { frontmatter, body } = parsePlaybookNotes(notes);
    const priorQuirks = frontmatter?.fetchQuirks ?? {};
    const changes: OrgPlan["changes"] = [];
    for (const e of bucket.entries) {
      const prior = priorQuirks[e.slug]?.changeDetector ?? null;
      if (prior !== e.detector) {
        changes.push({ slug: e.slug, from: prior, to: e.detector });
      }
    }
    plans.push({
      orgSlug,
      orgName: bucket.orgName,
      entries: bucket.entries,
      priorFrontmatter: frontmatter,
      priorBody: body,
      priorQuirkCount: Object.keys(priorQuirks).length,
      changes,
    });
  }

  plans.sort((a, b) => a.orgSlug.localeCompare(b.orgSlug));
  return { plans, stranded, skipped };
}

/** Build the merged notes string for a single org plan. */
function buildMergedNotes(plan: OrgPlan): string {
  const mergedQuirks: Record<string, FetchQuirk> = {
    ...plan.priorFrontmatter?.fetchQuirks,
  };
  for (const e of plan.entries) {
    mergedQuirks[e.slug] = {
      changeDetector: e.detector,
      rationale: e.rationale,
    };
  }
  const nextFrontmatter: PlaybookFrontmatter = {
    ...plan.priorFrontmatter,
    fetchQuirks: mergedQuirks,
  };
  return serializePlaybookNotes(nextFrontmatter, plan.priorBody);
}

async function main(): Promise<void> {
  const reportPath = resolve(process.cwd(), REPORT_PATH);
  const markdown = await readFile(reportPath, "utf-8");
  const report = parseReport(markdown);
  log(`Parsed ${report.length} classifications from ${REPORT_PATH}`);

  const { plans, stranded, skipped } = await planUpdates(report);

  if (skipped.length > 0) {
    log(`Skipping ${skipped.length}: ${skipped.map((s) => s.slug).join(", ")}`);
  }
  if (stranded.length > 0) {
    log(`STRANDED (no org match, will NOT update):`);
    for (const s of stranded) log(`  - ${s.slug}: ${s.reason}`);
  }

  log("");
  log(`Planning ${plans.length} org playbook update(s):`);
  for (const p of plans) {
    const addedEntries = p.entries.length;
    const changeSummary = p.changes.length === 0 ? "no changes" : `${p.changes.length} change(s)`;
    log(
      `  ${p.orgSlug} (${p.orgName}) — ${addedEntries} entries, prior quirks: ${p.priorQuirkCount}, ${changeSummary}`,
    );
    for (const c of p.changes) {
      log(`    · ${c.slug}: ${c.from ?? "<new>"} → ${c.to}`);
    }
  }

  const totalChanges = plans.reduce((acc, p) => acc + p.changes.length, 0);
  log("");
  if (totalChanges === 0) {
    log("No changes required — every entry already matches.");
  } else {
    log(
      `Total quirk mutations: ${totalChanges} across ${plans.filter((p) => p.changes.length > 0).length} org(s).`,
    );
  }

  if (!apply) {
    log("");
    log("Dry run — pass --apply to write.");
    if (jsonOut) {
      const out = {
        plans: plans.map((p) => ({
          orgSlug: p.orgSlug,
          orgName: p.orgName,
          priorQuirkCount: p.priorQuirkCount,
          changes: p.changes,
          mergedNotesPreview: buildMergedNotes(p).slice(0, 800),
        })),
        stranded,
        skipped: skipped.map((s) => s.slug),
      };
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    }
    return;
  }

  let updated = 0;
  for (const p of plans) {
    if (p.changes.length === 0) continue;
    const notes = buildMergedNotes(p);
    log(`  → PATCH ${p.orgSlug} (${p.changes.length} change(s))`);
    // oxlint-disable-next-line no-await-in-loop -- sequential: one PATCH per org, low volume
    await patchPlaybookNotes(p.orgSlug, notes);
    updated++;
  }
  log("");
  log(`Applied ${updated} playbook update(s).`);
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
