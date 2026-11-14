/**
 * Approval plan for a source recommendation: what source to create from the
 * suggested URL and which org it belongs to. Read-only — the admin
 * Submissions panel shows it as a prefilled form, and the writes go through
 * the existing routes (`POST /v1/orgs`, `POST /v1/sources`, the
 * recommendation PATCH and notify-added).
 *
 * The URL check is the deterministic `evaluateChangelog` pre-check (GitHub
 * detection, feed discovery, `.md` probing) — no model call.
 */
import { eq } from "drizzle-orm";
import type { EvaluationResult } from "@buildinternet/releases-api-types";
import { evaluateChangelog, sourceFromEvaluation } from "@releases/ai-internal/evaluate";
import { normalizeDomain } from "@buildinternet/releases-core/domain";
import {
  organizationsActive,
  recommendations,
  sourcesActive,
} from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import { registrableDomain } from "@releases/adapters/registrable-domain";
import { findOrgByDomain } from "@releases/queries/domain-lookup";
import type { createDb } from "../../db.js";
import { resolveRelatedOrg } from "../search/lookup-related-org.js";

type Db = ReturnType<typeof createDb>;

export interface RecommendationPlan {
  recommendationId: string;
  evaluation: EvaluationResult;
  /** The source to create, ready for `POST /v1/sources` (metadata as an object). */
  source: ReturnType<typeof sourceFromEvaluation> & { name: string };
  /** Existing org this URL most likely belongs to, or null. */
  matchedOrg: { slug: string; name: string } | null;
  /** Prefill for creating a new org when nothing matched. */
  newOrg: { name: string; slug: string; domain: string | null };
  /** A live source already at this URL (approving would duplicate it). */
  existingSource: { orgSlug: string; slug: string; name: string } | null;
}

export type Evaluate = (url: string) => Promise<EvaluationResult>;

function titleCase(label: string): string {
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Org for a host: exact match first, then its registrable parent ("docs.acme.com" → "acme.com"). */
async function findOrgForHost(db: Db, host: string, root: string) {
  for (const candidate of new Set([host, root])) {
    // oxlint-disable-next-line no-await-in-loop -- at most two, most specific first
    const hit = await findOrgByDomain(db, candidate);
    if (hit) return { slug: hit.slug, name: hit.name };
  }
  return null;
}

export async function buildRecommendationPlan(
  db: Db,
  recommendationId: string,
  evaluate: Evaluate = evaluateChangelog,
): Promise<RecommendationPlan | null> {
  const [rec] = await db
    .select({ id: recommendations.id, url: recommendations.url })
    .from(recommendations)
    .where(eq(recommendations.id, recommendationId))
    .limit(1);
  if (!rec) return null;

  const evaluation = await evaluate(rec.url);
  const source = sourceFromEvaluation(rec.url, evaluation);
  const [githubOwner, githubName] = evaluation.githubRepo?.split("/") ?? [];
  const host = githubOwner ? null : normalizeDomain(rec.url);
  const root = host ? registrableDomain(host) : null;

  // GitHub owners resolve the same way `/v1/lookups` does (existing repo URLs, then slug).
  const matchedOrg = githubOwner
    ? ((await resolveRelatedOrg(db, githubOwner))?.org ?? null)
    : host && root
      ? await findOrgForHost(db, host, root)
      : null;

  const orgName = matchedOrg?.name ?? titleCase(githubOwner ?? root?.split(".")[0] ?? "New org");

  const [existingSource] = await db
    .select({
      orgSlug: organizationsActive.slug,
      slug: sourcesActive.slug,
      name: sourcesActive.name,
    })
    .from(sourcesActive)
    .innerJoin(organizationsActive, eq(organizationsActive.id, sourcesActive.orgId))
    .where(eq(sourcesActive.url, source.url))
    .limit(1);

  return {
    recommendationId: rec.id,
    evaluation,
    source: {
      ...source,
      name: githubName ? titleCase(githubName) : `${orgName} Changelog`,
    },
    matchedOrg: matchedOrg && { slug: matchedOrg.slug, name: matchedOrg.name },
    newOrg: { name: orgName, slug: toSlug(orgName), domain: root },
    existingSource: existingSource ?? null,
  };
}
