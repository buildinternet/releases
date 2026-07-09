/**
 * Search quality eval — live public `/v1/search` against soft relevance
 * fixtures. LOCAL / AD-HOC ONLY (network + prod data). Not part of `bun test`.
 *
 * Run:
 *   bun run eval:search
 *   RELEASES_API_URL=https://api.staging.releases.sh bun run eval:search
 *   SEARCH_EVAL_COMPARE_MODES=1 bun run eval:search
 *
 * Gate: every severity=must case must pass; should cases are reported only.
 * Results: ~/.releases/evals/results/search-*.json
 */
import { readFileSync } from "fs";
import { join } from "path";
import { saveRun } from "./results";

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_API = "https://api.releases.sh";
const DEFAULT_MODE = "hybrid" as const;
const DEFAULT_LIMIT = 10;
/** Soft floor: all must-cases pass. should-cases do not affect the gate. */
const MODES = ["lexical", "semantic", "hybrid"] as const;
type Mode = (typeof MODES)[number];

// ── Fixture types ───────────────────────────────────────────────────

type Intent = "entity_lookup" | "concept" | "noise" | "product_feature";
type Severity = "must" | "should";

interface SectionExpect {
  minHits?: number;
  /** At least one of these slugs appears in the top hits for this section. */
  anySlugInTop?: string[];
  /** At least one hit's orgSlug is in this set. */
  anyOrgSlugInTop?: string[];
  /**
   * Fraction of topK release/catalog hits whose orgSlug equals `slug`
   * (default minFraction 0.6). Catches hybrid pollution that soft
   * anyOrgSlugInTop misses (e.g. langfuse:test at rank 1).
   */
  majorityOrgInTop?: { slug: string; minFraction?: number };
  /** None of these org slugs may appear in topK. */
  mustNotOrgSlugInTop?: string[];
  /** At least one hit matches any of these substrings (case-insensitive). */
  anyTextContainsAny?: string[];
  /** Only inspect the first topK hits (default: all returned). */
  topK?: number;
}

interface CaseExpect {
  notDegraded?: boolean;
  orgs?: SectionExpect;
  catalog?: SectionExpect;
  releases?: SectionExpect;
  collections?: SectionExpect;
  chunks?: SectionExpect;
}

interface SearchCase {
  id: string;
  query: string;
  intent: Intent;
  severity: Severity;
  notes?: string;
  /** Override modes (default: hybrid only, or all when COMPARE_MODES=1). */
  modes?: Mode[];
  type?: Array<"orgs" | "catalog" | "releases" | "collections">;
  limit?: number;
  expect: CaseExpect;
}

// ── Wire shape (subset of UnifiedSearchResponse) ────────────────────

interface WireOrg {
  slug: string;
  name: string;
}
interface WireCatalog {
  slug: string;
  name: string;
  orgSlug: string | null;
}
interface WireRelease {
  id: string;
  title: string;
  summary: string;
  orgSlug: string | null;
  sourceSlug: string;
  sourceName: string;
}
interface WireCollection {
  slug: string;
  name: string;
  description: string | null;
}
interface WireChunk {
  sourceSlug: string;
  orgSlug: string | null;
  heading: string | null;
  snippet: string;
}

interface WireSearch {
  query: string;
  mode?: Mode;
  degraded?: boolean;
  degradedReason?: string;
  orgs: WireOrg[];
  catalog: WireCatalog[];
  releases: WireRelease[];
  collections?: WireCollection[];
  chunks?: WireChunk[];
}

// ── Grading ─────────────────────────────────────────────────────────

interface Check {
  field: string;
  passed: boolean;
  detail: string;
}

function takeTop<T>(items: T[], topK?: number): T[] {
  if (topK === undefined || topK <= 0) return items;
  return items.slice(0, topK);
}

function includesAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

function gradeSection(
  section: string,
  hits: Array<{
    slug?: string;
    name?: string;
    orgSlug?: string | null;
    title?: string;
    summary?: string;
    description?: string | null;
    heading?: string | null;
    snippet?: string;
    sourceSlug?: string;
    sourceName?: string;
  }>,
  expect: SectionExpect | undefined,
): Check[] {
  if (!expect) return [];
  const checks: Check[] = [];
  const top = takeTop(hits, expect.topK);

  if (expect.minHits !== undefined) {
    checks.push({
      field: `${section}.minHits`,
      passed: hits.length >= expect.minHits,
      detail: `got ${hits.length}, need ≥ ${expect.minHits}`,
    });
  }

  if (expect.anySlugInTop?.length) {
    const slugs = new Set(top.map((h) => h.slug).filter(Boolean) as string[]);
    const hit = expect.anySlugInTop.find((s) => slugs.has(s));
    checks.push({
      field: `${section}.anySlugInTop`,
      passed: hit !== undefined,
      detail: hit
        ? `matched ${hit}`
        : `want one of [${expect.anySlugInTop.join(", ")}]; got [${[...slugs].slice(0, 8).join(", ")}]`,
    });
  }

  if (expect.anyOrgSlugInTop?.length) {
    const orgs = new Set(
      top.map((h) => h.orgSlug).filter((s): s is string => typeof s === "string" && s.length > 0),
    );
    const hit = expect.anyOrgSlugInTop.find((s) => orgs.has(s));
    checks.push({
      field: `${section}.anyOrgSlugInTop`,
      passed: hit !== undefined,
      detail: hit
        ? `matched org ${hit}`
        : `want one of [${expect.anyOrgSlugInTop.join(", ")}]; got [${[...orgs].slice(0, 8).join(", ")}]`,
    });
  }

  if (expect.majorityOrgInTop) {
    const want = expect.majorityOrgInTop.slug;
    const minFraction = expect.majorityOrgInTop.minFraction ?? 0.6;
    const orgList = top.map((h) => h.orgSlug).filter((s): s is string => typeof s === "string");
    const denom = Math.max(orgList.length, 1);
    const matched = orgList.filter((o) => o === want).length;
    const fraction = orgList.length === 0 ? 0 : matched / denom;
    checks.push({
      field: `${section}.majorityOrgInTop`,
      passed: orgList.length > 0 && fraction + 1e-9 >= minFraction,
      detail: `${matched}/${orgList.length} = ${(fraction * 100).toFixed(0)}% ${want} (need ≥ ${(minFraction * 100).toFixed(0)}%); top=[${orgList.join(", ")}]`,
    });
  }

  if (expect.mustNotOrgSlugInTop?.length) {
    const banned = new Set(expect.mustNotOrgSlugInTop);
    const offenders = top
      .map((h) => h.orgSlug)
      .filter((s): s is string => typeof s === "string" && banned.has(s));
    checks.push({
      field: `${section}.mustNotOrgSlugInTop`,
      passed: offenders.length === 0,
      detail:
        offenders.length === 0
          ? "ok"
          : `banned orgs present: [${[...new Set(offenders)].join(", ")}]`,
    });
  }

  if (expect.anyTextContainsAny?.length) {
    const blob = top
      .map((h) =>
        [h.slug, h.name, h.title, h.summary, h.description, h.heading, h.snippet, h.sourceName]
          .filter(Boolean)
          .join(" "),
      )
      .join(" \n ");
    const ok = includesAny(blob, expect.anyTextContainsAny);
    checks.push({
      field: `${section}.anyTextContainsAny`,
      passed: ok,
      detail: ok
        ? "matched keyword"
        : `none of [${expect.anyTextContainsAny.join(", ")}] in top ${top.length}`,
    });
  }

  return checks;
}

function gradeResponse(body: WireSearch, expect: CaseExpect): Check[] {
  const checks: Check[] = [];

  if (expect.notDegraded) {
    checks.push({
      field: "notDegraded",
      passed: body.degraded !== true,
      detail: body.degraded === true ? `degraded: ${body.degradedReason ?? "unknown"}` : "ok",
    });
  }

  checks.push(
    ...gradeSection("orgs", body.orgs ?? [], expect.orgs),
    ...gradeSection(
      "catalog",
      (body.catalog ?? []).map((c) => ({
        slug: c.slug,
        name: c.name,
        orgSlug: c.orgSlug,
      })),
      expect.catalog,
    ),
    ...gradeSection(
      "releases",
      (body.releases ?? []).map((r) => ({
        slug: r.id,
        name: r.title,
        title: r.title,
        summary: r.summary,
        orgSlug: r.orgSlug,
        sourceSlug: r.sourceSlug,
        sourceName: r.sourceName,
      })),
      expect.releases,
    ),
    ...gradeSection(
      "collections",
      (body.collections ?? []).map((c) => ({
        slug: c.slug,
        name: c.name,
        description: c.description,
      })),
      expect.collections,
    ),
    ...gradeSection(
      "chunks",
      (body.chunks ?? []).map((c) => ({
        slug: c.sourceSlug,
        orgSlug: c.orgSlug,
        heading: c.heading,
        snippet: c.snippet,
        sourceSlug: c.sourceSlug,
      })),
      expect.chunks,
    ),
  );

  return checks;
}

// ── Fetch ───────────────────────────────────────────────────────────

function apiBase(): string {
  const raw = process.env.RELEASES_API_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_API).replace(/\/$/, "");
}

async function search(
  query: string,
  mode: Mode,
  opts: { limit?: number; type?: string[] } = {},
): Promise<{ body: WireSearch; durationMs: number; status: number }> {
  const params = new URLSearchParams({
    q: query,
    mode,
    limit: String(opts.limit ?? DEFAULT_LIMIT),
  });
  if (opts.type?.length) params.set("type", opts.type.join(","));

  const url = `${apiBase()}/v1/search?${params}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "releases-search-eval/1.0 (+https://github.com/buildinternet/releases)",
      "X-Releases-Surface": "api",
    },
  });
  const durationMs = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as WireSearch;
  return { body, durationMs, status: res.status };
}

// ── Main ────────────────────────────────────────────────────────────

interface CaseResult {
  id: string;
  query: string;
  intent: Intent;
  severity: Severity;
  mode: Mode;
  passed: boolean;
  durationMs: number;
  checks: Check[];
  topOrgs: string[];
  topReleaseOrgs: string[];
  topReleaseTitles: string[];
  notes?: string;
}

async function main() {
  const fixtures = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/search/cases.json"), "utf8"),
  ) as SearchCase[];

  const compareModes = process.env.SEARCH_EVAL_COMPARE_MODES === "1";
  const base = apiBase();
  console.error(`Search eval → ${base}  (compareModes=${compareModes})`);

  const results: CaseResult[] = [];

  for (const c of fixtures) {
    const modes: Mode[] = c.modes?.length ? c.modes : compareModes ? [...MODES] : [DEFAULT_MODE];

    for (const mode of modes) {
      // oxlint-disable-next-line no-await-in-loop -- sequential to avoid burst rate limits
      const { body, durationMs } = await search(c.query, mode, {
        limit: c.limit ?? DEFAULT_LIMIT,
        type: c.type,
      });
      const checks = gradeResponse(body, c.expect);
      const passed = checks.every((ch) => ch.passed);
      const row: CaseResult = {
        id: c.id,
        query: c.query,
        intent: c.intent,
        severity: c.severity,
        mode,
        passed,
        durationMs,
        checks,
        topOrgs: (body.orgs ?? []).slice(0, 5).map((o) => o.slug),
        topReleaseOrgs: (body.releases ?? []).slice(0, 5).map((r) => r.orgSlug ?? "?"),
        topReleaseTitles: (body.releases ?? []).slice(0, 5).map((r) => r.title.slice(0, 60)),
        notes: c.notes,
      };
      results.push(row);

      const mark = passed ? "PASS" : "FAIL";
      const failed = checks.filter((ch) => !ch.passed).map((ch) => ch.field);
      console.error(
        `${mark}  [${c.severity}] ${c.id} mode=${mode} ${durationMs}ms` +
          (failed.length ? `  ✗ ${failed.join(", ")}` : ""),
      );
      if (!passed) {
        for (const ch of checks.filter((x) => !x.passed)) {
          console.error(`       ${ch.field}: ${ch.detail}`);
        }
      }
    }
  }

  // Primary gate uses hybrid (or sole mode) rows with severity=must.
  const mustHybrid = results.filter(
    (r) => r.severity === "must" && (r.mode === DEFAULT_MODE || !compareModes),
  );
  // When not comparing, every result is the default mode; when comparing,
  // gate only on hybrid must-cases so lexical/semantic don't fail the run.
  const gateRows = compareModes
    ? results.filter((r) => r.severity === "must" && r.mode === DEFAULT_MODE)
    : results.filter((r) => r.severity === "must");

  const mustPass = gateRows.filter((r) => r.passed).length;
  const mustTotal = gateRows.length;
  const shouldRows = results.filter((r) => r.severity === "should" && r.mode === DEFAULT_MODE);
  const shouldPass = shouldRows.filter((r) => r.passed).length;

  const pass = mustTotal > 0 && mustPass === mustTotal;

  // Mode comparison rollup (when enabled): per-case which modes passed.
  if (compareModes) {
    console.error(`\n${"─".repeat(60)}`);
    console.error("Mode comparison (PASS=1 / FAIL=0):");
    const byId = new Map<string, CaseResult[]>();
    for (const r of results) {
      const list = byId.get(r.id) ?? [];
      list.push(r);
      byId.set(r.id, list);
    }
    for (const [id, rows] of byId) {
      const bits = MODES.map((m) => {
        const row = rows.find((r) => r.mode === m);
        return `${m[0]}=${row ? (row.passed ? "1" : "0") : "-"}`;
      }).join(" ");
      console.error(`  ${id.padEnd(32)} ${bits}`);
    }
  }

  console.error(`\n${"=".repeat(60)}`);
  console.error(
    `Search quality: must ${mustPass}/${mustTotal}  should ${shouldPass}/${shouldRows.length}  → ${pass ? "PASS" : "FAIL"}`,
  );
  console.error(`API: ${base}`);

  const path = saveRun({
    eval: "search",
    model: `search/${DEFAULT_MODE}`,
    pass,
    summary: {
      api: base,
      compareModes,
      mustPass,
      mustTotal,
      shouldPass,
      shouldTotal: shouldRows.length,
      mustHybridPass: mustHybrid.filter((r) => r.passed).length,
      mustHybridTotal: mustHybrid.length,
    },
    cases: results,
  });
  console.error(`Saved: ${path}`);

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
