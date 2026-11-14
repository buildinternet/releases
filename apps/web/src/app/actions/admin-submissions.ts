"use server";

import { adminActionEnv, adminFetch, type AdminResult } from "@/lib/admin-action";
import {
  submissionsQueryString,
  type ApproveRecommendationInput,
  type ApproveRecommendationResult,
  type PromoteResult,
  type RecommendationPlan,
  type SubmissionsQuery,
  type SubmissionsResponse,
  type TriagePatch,
} from "@/lib/admin-submissions";

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

export async function listSubmissionsAction(
  query: SubmissionsQuery = {},
): Promise<AdminResult<SubmissionsResponse>> {
  return adminFetch(`/v1/admin/submissions${submissionsQueryString(query)}`);
}

/**
 * Triage a recommendation or feedback row through its existing admin PATCH
 * route (`/v1/recommendations/:id`, `/v1/feedback/:id`) — no new write path.
 */
export async function triageSubmissionAction(
  kind: "recommendation" | "feedback",
  id: string,
  patch: TriagePatch,
): Promise<AdminResult<unknown>> {
  const base = kind === "recommendation" ? "recommendations" : "feedback";
  return adminFetch(`/v1/${base}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getRecommendationPlanAction(
  id: string,
): Promise<AdminResult<RecommendationPlan>> {
  return adminFetch(`/v1/admin/submissions/recommendations/${encodeURIComponent(id)}/plan`);
}

/** Preview (`dryRun`) or run the existing stub → tracked promotion. */
export async function promoteOrgAction(
  slug: string,
  dryRun: boolean,
): Promise<AdminResult<PromoteResult>> {
  const qs = dryRun ? "?dryRun=1" : "";
  return adminFetch(`/v1/orgs/${encodeURIComponent(slug)}/promote${qs}`, post());
}

/**
 * Approve a source recommendation by chaining the existing write routes:
 * create the org (if new) → create the source → close the recommendation →
 * optional "your source was added" email. The source create is the commit
 * point and already starts the onboarding backfill fetch (skipped with
 * `X-Onboard-Mode: manual` when `fetchNow` is off). Later steps are
 * best-effort and come back as warnings.
 */
export async function approveRecommendationAction(
  input: ApproveRecommendationInput,
): Promise<AdminResult<ApproveRecommendationResult>> {
  // One credential for the whole chain (prod mints a per-user JWT per resolve).
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };

  let orgSlug: string;
  if ("create" in input.org) {
    const { name, slug, domain } = input.org.create;
    const org = await adminFetch<{ slug: string }>(
      "/v1/orgs",
      post({ name, slug, ...(domain ? { domain } : {}) }),
      env,
    );
    if (!org.ok) return { ok: false, error: `Creating org failed. ${org.error}` };
    orgSlug = org.data.slug;
  } else {
    orgSlug = input.org.slug;
  }

  const { name, url, type, metadata } = input.source;
  const source = await adminFetch<{ id: string; slug: string }>(
    "/v1/sources",
    {
      ...post({ name, url, type, orgSlug, metadata: JSON.stringify(metadata) }),
      ...(!input.fetchNow && { headers: { "X-Onboard-Mode": "manual" } }),
    },
    env,
  );
  if (!source.ok) {
    const created =
      "create" in input.org ? ` Org ${orgSlug} was created; retry as an existing org.` : "";
    return { ok: false, error: `Creating source failed. ${source.error}${created}` };
  }

  const warnings: string[] = [];
  const step = async (label: string, res: Promise<AdminResult<unknown>>) => {
    const r = await res;
    if (!r.ok) warnings.push(`${label} failed. ${r.error}`);
  };
  const recPath = `/recommendations/${encodeURIComponent(input.recommendationId)}`;
  await step(
    "Closing the suggestion",
    adminFetch(
      `/v1${recPath}`,
      { method: "PATCH", body: JSON.stringify({ status: "closed" }) },
      env,
    ),
  );
  if (input.notify) {
    await step(
      "Emailing the submitter",
      adminFetch(
        `/v1/admin${recPath}/notify-added`,
        post({ orgSlug, sourceSlug: source.data.slug }),
        env,
      ),
    );
  }

  return { ok: true, data: { orgSlug, sourceSlug: source.data.slug, warnings } };
}
