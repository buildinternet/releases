/**
 * Wire shape of `GET /v1/admin/submissions` (apps/api/src/routes/admin-submissions.ts).
 * Internal admin route, so the type lives here rather than in the published
 * api-types package.
 */
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
