/**
 * Wire shape of `GET /v1/admin/submissions` (apps/api/src/routes/admin-submissions.ts).
 * Internal admin route, so the type lives here rather than in the published
 * api-types package.
 */
import type { EvaluationResult } from "@buildinternet/releases-api-types";

// Type-only (erased), so client components can use it without pulling in the
// server-only admin-action module.
export type { AdminResult as Result } from "./admin-action";

export type TriagePatch = { status?: "new" | "triaged" | "closed"; archived?: boolean };

export const SUBMISSION_KINDS = [
  "recommendation",
  "feedback",
  "tracking-request",
  "claim",
] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export const SUBMISSION_KIND_LABEL: Record<SubmissionKind, string> = {
  recommendation: "Source suggestion",
  feedback: "Feedback",
  "tracking-request": "Tracking request",
  claim: "Ownership claim",
};

export interface SubmissionItem {
  id: string;
  kind: SubmissionKind;
  /** Epoch ms. */
  createdAt: number;
  title: string;
  detail: string | null;
  url: string | null;
  contact: string | null;
  status: string;
  archived: boolean;
  open: boolean;
  surface: string | null;
  org: { slug: string; name: string; domain: string | null } | null;
}

export interface SubmissionsResponse {
  items: SubmissionItem[];
  openCounts: Record<SubmissionKind, number>;
}

export interface SubmissionsQuery {
  kind?: SubmissionKind | null;
  /** `open` (default) hides closed/archived/promoted/expired items. */
  state?: "open" | "all";
}

/** Kinds whose rows carry a triage `status` + `archived` flag we can PATCH. */
export function isTriageable(kind: SubmissionKind): kind is "recommendation" | "feedback" {
  return kind === "recommendation" || kind === "feedback";
}

export function submissionsQueryString(q: SubmissionsQuery): string {
  const params = new URLSearchParams();
  if (q.kind) params.set("kind", q.kind);
  if (q.state === "all") params.set("state", "all");
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** `GET /v1/admin/submissions/recommendations/:id/plan` (subset the panel uses). */
export interface RecommendationPlan {
  recommendationId: string;
  evaluation: Pick<EvaluationResult, "recommendedMethod" | "confidence" | "feedUrl">;
  source: {
    name: string;
    url: string;
    type: "github" | "feed" | "scrape";
    metadata: Record<string, unknown>;
  };
  matchedOrg: { slug: string; name: string } | null;
  newOrg: { name: string; slug: string; domain: string | null };
  existingSource: { orgSlug: string; slug: string; name: string } | null;
}

/** What the operator confirmed in the approve panel. */
export interface ApproveRecommendationInput {
  recommendationId: string;
  /** Existing org slug, or a new org to create first. */
  org: { slug: string } | { create: { name: string; slug: string; domain: string | null } };
  source: RecommendationPlan["source"];
  /** Run the onboarding backfill fetch now (otherwise the source waits for its schedule). */
  fetchNow: boolean;
  /** Email the submitter (only sent when the recommendation has a contact). */
  notify: boolean;
}

export interface ApproveRecommendationResult {
  orgSlug: string;
  sourceSlug: string;
  /** Non-fatal follow-up failures (closing, email). */
  warnings: string[];
}

/** `POST /v1/orgs/:slug/promote` (subset the panel uses). */
export interface PromoteResult {
  promoted: boolean;
  alreadyTracked?: boolean;
  sourcesCreated: number;
  sourcesMatched: number;
  plan?: {
    sources: Array<{
      action: "match" | "create" | "skip";
      type: string;
      locator: string;
      title: string;
      paused: boolean;
      note?: string;
    }>;
  };
}
