/**
 * `source fetch --local` — the local-ingest handoff.
 *
 * This is the discoverable on-ramp for the monorepo `local-ingest` skill
 * (buildinternet/releases#1344). Instead of POSTing to `/v1/workflows/update`
 * (which dispatches a remote managed-agent extraction session, billed even when
 * it writes zero releases), `--local` stages the local path: it runs the
 * robots.txt / Content-Signal opt-out preflight, resolves the source, discovers
 * candidate page URLs, and prints a structured handoff brief the skill consumes.
 *
 * No managed agent, no model call, no Anthropic/adapter dependency — the thin
 * client only does HTTP `fetch` + string parsing. The skill does the extraction.
 */

import chalk from "chalk";
import { findOrg } from "../../api/orgs.js";
import { findSource } from "../../api/sources.js";
import { sourceNotFound } from "../suggest.js";
import { writeJson } from "../../lib/output.js";
import {
  contentSignalPreflight,
  type ContentSignalResult,
  type ContentSignalVerdict,
} from "../../lib/content-signal.js";
import { discoverCandidateUrls, type DiscoveryResult } from "../../lib/page-discovery.js";

export interface LocalHandoffOpts {
  json?: boolean;
  force?: boolean;
}

interface HandoffBrief {
  source: { id: string; slug: string; type: string; url: string };
  org: { slug: string } | null;
  /** Org-scoped batch endpoint (preferred); falls back to the typed-id form. */
  batchEndpoint: string;
  preflight: {
    verdict: ContentSignalVerdict;
    forced: boolean;
    reason: string;
    robotsUrl: string;
    robotsStatus: number | null;
    contentSignal: Record<string, string> | null;
    sitemaps: string[];
    blocked: string[];
  };
  /** Null when the preflight refused and `--force` was not passed. */
  discovery: DiscoveryResult | null;
  nextStep: string;
}

/**
 * Exit codes mirror the skill's preflight gate so automation can branch:
 *   0 proceed (or operator --force override)
 *   1 refuse  (ai-input=no / ai-train=no, no --force)
 *   2 unknown (could not read robots.txt; surfaced, not assumed)
 */
function exitCodeFor(verdict: ContentSignalVerdict, force: boolean): number {
  if (force) return 0;
  if (verdict === "refuse") return 1;
  if (verdict === "unknown") return 2;
  return 0;
}

/**
 * Stage the local-ingest handoff for a single source. Resolves the source +
 * org, runs the Content-Signal preflight, and (unless refused without --force)
 * discovers candidate URLs, then prints the brief. Returns normally on a clean
 * proceed; calls `process.exit` with the gate code on refuse/unknown.
 */
export async function runLocalHandoff(identifier: string, opts: LocalHandoffOpts): Promise<void> {
  const source = await findSource(identifier);
  if (!source) return sourceNotFound(identifier); // exits 1 (AmbiguousSourceError propagates)

  const org = source.orgId ? await findOrg(source.orgId).catch(() => null) : null;
  const batchEndpoint = org?.slug
    ? `/v1/orgs/${org.slug}/sources/${source.slug}/releases/batch`
    : `/v1/sources/${source.id}/releases/batch`;

  const pf = await contentSignalPreflight(source.url);
  const force = opts.force === true;
  const refusedWithoutForce = pf.verdict === "refuse" && !force;

  // On a hard refusal we stop before enumerating pages — the point is not to
  // stage ingestion against an opt-out. --force re-opens discovery.
  const discovery = refusedWithoutForce
    ? null
    : await discoverCandidateUrls({ sourceUrl: source.url, sitemaps: pf.sitemaps });

  const brief: HandoffBrief = {
    source: { id: source.id, slug: source.slug, type: source.type, url: source.url },
    org: org?.slug ? { slug: org.slug } : null,
    batchEndpoint,
    preflight: {
      verdict: pf.verdict,
      forced: pf.verdict === "refuse" && force,
      reason: pf.reason,
      robotsUrl: pf.robotsUrl,
      robotsStatus: pf.robotsStatus,
      contentSignal: pf.contentSignal,
      sitemaps: pf.sitemaps,
      blocked: pf.blocked,
    },
    discovery,
    nextStep: refusedWithoutForce
      ? "Refused by the Content-Signal opt-out. Re-run with --force only if you have explicit publisher permission."
      : "Run the `local-ingest` skill: extract releases yourself and write them via the batch endpoint above (no managed agent).",
  };

  const exitCode = exitCodeFor(pf.verdict, force);

  if (opts.json) {
    await writeJson({ ...brief, exitCode });
  } else {
    printHandoffBrief(brief, pf, { force, exitCode });
  }

  // Return normally on a clean proceed so callers/tests don't trip process.exit;
  // signal refuse/unknown with the gate code.
  if (exitCode !== 0) process.exit(exitCode);
}

const VERDICT_BADGE: Record<ContentSignalVerdict, (s: string) => string> = {
  proceed: (s) => chalk.green(s),
  refuse: (s) => chalk.red(s),
  unknown: (s) => chalk.yellow(s),
};

function printHandoffBrief(
  brief: HandoffBrief,
  pf: ContentSignalResult,
  ctx: { force: boolean; exitCode: number },
): void {
  const coord = brief.org ? `${brief.org.slug}/${brief.source.slug}` : brief.source.slug;
  const badge = ctx.force && pf.verdict === "refuse" ? "FORCED" : pf.verdict.toUpperCase();

  // The whole brief goes to stdout so it stays readable and pipeable; the exit
  // code is the machine signal (0 proceed / 1 refuse / 2 unknown).
  console.log(`${VERDICT_BADGE[pf.verdict](`[preflight ${badge}]`)} ${coord}`);
  console.log(`  source:  ${brief.source.type}  ${brief.source.url}  (${brief.source.id})`);
  console.log(`  robots:  ${pf.robotsUrl} (HTTP ${pf.robotsStatus ?? "—"})`);
  if (pf.contentSignal) {
    const pairs = Object.entries(pf.contentSignal)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`  signal:  ${pairs}`);
  }
  if (pf.sitemaps.length) console.log(`  sitemap: ${pf.sitemaps.join(", ")}`);
  console.log(`  reason:  ${pf.reason}`);

  if (!brief.discovery) {
    // Refused without --force — stop here, no candidate enumeration.
    console.log("");
    console.log(chalk.red(brief.nextStep));
    return;
  }

  const d = brief.discovery;
  console.log("");
  console.log(`  batch:   POST ${brief.batchEndpoint}`);
  console.log(`  shape:   ${d.pageStructure} (via ${d.via})`);
  console.log(`  ${chalk.dim(d.note)}`);
  if (d.candidates.length) {
    console.log(chalk.dim(`  candidate URLs (${d.candidates.length}):`));
    for (const url of d.candidates) console.log(`    ${url}`);
  }
  if (ctx.exitCode === 2) {
    console.log("");
    console.log(
      chalk.yellow("  Preflight could not confirm the opt-out policy — operator review advised."),
    );
  }
  console.log("");
  console.log(chalk.dim(`Next: ${brief.nextStep}`));
}
