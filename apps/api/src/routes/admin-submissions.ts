/**
 * Admin-only consolidated inbox of everything users submit, newest first.
 * Gated by authMiddleware via the "admin/submissions" entry in
 * route-namespaces.ts. Read-only: it unions the existing per-kind tables so an
 * operator sees one list; triage writes stay on the existing per-kind routes
 * (`PATCH /v1/recommendations/:id`, `PATCH /v1/feedback/:id`, org promote, …).
 *
 * Kinds:
 * - `recommendation` — a source URL suggested from the web `/submit` form or CLI.
 * - `feedback` — CLI / web "report an issue" feedback.
 * - `tracking-request` — a domain owner asked us to track their listing
 *   (`organizations.tracking_requested_at`, self-serve lane).
 * - `claim` — an ownership claim on a listed domain (`org_claims`).
 *
 * "Open" (the default view) means still in play: recommendation/feedback not
 * closed and not archived, tracking request on an org that is still a stub,
 * claim pending or verified (not expired/revoked).
 */
import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import {
  feedback,
  orgClaims,
  organizations,
  recommendations,
} from "@buildinternet/releases-core/schema";
import { user } from "../db/schema-auth.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminSubmissionRoutes = new Hono<Env>();

export const SUBMISSION_KINDS = [
  "recommendation",
  "feedback",
  "tracking-request",
  "claim",
] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

export interface SubmissionOrgRef {
  slug: string;
  name: string;
  domain: string | null;
}

export interface SubmissionItem {
  /** Underlying row id (`rec_…`, `fb_…`, `org_…`, `clm_…`). */
  id: string;
  kind: SubmissionKind;
  /** Epoch ms — normalized across kinds (some tables store ISO text). */
  createdAt: number;
  /** One-line headline: the URL, the feedback message, the org name. */
  title: string;
  /** Secondary free text (recommendation note, feedback type, claim method). */
  detail: string | null;
  /** External link worth opening (the recommended URL, the org domain). */
  url: string | null;
  /** Submitter contact (email) when we have one. */
  contact: string | null;
  /** Kind-specific status string (`new`/`triaged`/`closed`, `stub`/`tracked`, claim status). */
  status: string;
  archived: boolean;
  /** Whether the item is still "open" per the rules in the file header. */
  open: boolean;
  /** Where it came from (`web`, `cli`, …) when recorded. */
  surface: string | null;
  org: SubmissionOrgRef | null;
}

export interface SubmissionsResponse {
  items: SubmissionItem[];
  /** Open-item counts per kind, independent of the `kind` filter. */
  openCounts: Record<SubmissionKind, number>;
}

function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 100, 200));
}

function isoToMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function domainUrl(domain: string | null): string | null {
  return domain ? `https://${domain}` : null;
}

type Db = ReturnType<typeof createDb>;

const recOpen = and(ne(recommendations.status, "closed"), eq(recommendations.archived, false))!;
const fbOpen = and(ne(feedback.status, "closed"), eq(feedback.archived, false))!;
const trackingBase = and(
  isNotNull(organizations.trackingRequestedAt),
  isNull(organizations.deletedAt),
)!;
const trackingOpen = and(trackingBase, eq(organizations.tier, "stub"))!;
const claimOpen = inArray(orgClaims.status, ["pending", "verified"]);

async function loadRecommendations(db: Db, openOnly: boolean, limit: number) {
  const rows = await db
    .select()
    .from(recommendations)
    .where(openOnly ? recOpen : undefined)
    .orderBy(desc(recommendations.createdAt), desc(recommendations.id))
    .limit(limit);
  return rows.map((r): SubmissionItem => ({
    id: r.id,
    kind: "recommendation",
    createdAt: r.createdAt,
    title: r.url,
    detail: r.note ?? null,
    url: r.url,
    contact: r.contactEmail ?? null,
    status: r.status,
    archived: r.archived,
    open: r.status !== "closed" && !r.archived,
    surface: r.surface,
    org: null,
  }));
}

async function loadFeedback(db: Db, openOnly: boolean, limit: number) {
  const rows = await db
    .select()
    .from(feedback)
    .where(openOnly ? fbOpen : undefined)
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(limit);
  return rows.map((r): SubmissionItem => ({
    id: r.id,
    kind: "feedback",
    createdAt: r.createdAt,
    title: r.message,
    detail: r.type,
    url: null,
    contact: r.contact ?? null,
    status: r.status,
    archived: r.archived,
    open: r.status !== "closed" && !r.archived,
    surface: r.surface,
    org: null,
  }));
}

async function loadTrackingRequests(db: Db, openOnly: boolean, limit: number) {
  const rows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      domain: organizations.domain,
      tier: organizations.tier,
      trackingRequestedAt: organizations.trackingRequestedAt,
    })
    .from(organizations)
    .where(openOnly ? trackingOpen : trackingBase)
    .orderBy(desc(organizations.trackingRequestedAt))
    .limit(limit);
  return rows.map((r): SubmissionItem => ({
    id: r.id,
    kind: "tracking-request",
    createdAt: isoToMs(r.trackingRequestedAt),
    title: r.name,
    detail: r.domain ? `Tracking requested for ${r.domain}` : "Tracking requested",
    url: domainUrl(r.domain),
    contact: null,
    status: r.tier,
    archived: false,
    open: r.tier === "stub",
    surface: "web",
    org: { slug: r.slug, name: r.name, domain: r.domain },
  }));
}

async function loadClaims(db: Db, openOnly: boolean, limit: number) {
  const rows = await db
    .select({
      id: orgClaims.id,
      status: orgClaims.status,
      method: orgClaims.method,
      createdAt: orgClaims.createdAt,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      orgDomain: organizations.domain,
      email: user.email,
      displayEmail: user.displayEmail,
    })
    .from(orgClaims)
    .innerJoin(organizations, eq(organizations.id, orgClaims.orgId))
    .leftJoin(user, eq(user.id, orgClaims.userId))
    .where(openOnly ? claimOpen : undefined)
    .orderBy(desc(orgClaims.createdAt), desc(orgClaims.id))
    .limit(limit);
  return rows.map((r): SubmissionItem => ({
    id: r.id,
    kind: "claim",
    createdAt: isoToMs(r.createdAt),
    title: r.orgName,
    detail: r.method
      ? `Ownership claim on ${r.orgDomain ?? r.orgSlug} (verified via ${r.method})`
      : `Ownership claim on ${r.orgDomain ?? r.orgSlug}`,
    url: domainUrl(r.orgDomain),
    contact: r.displayEmail ?? r.email ?? null,
    status: r.status,
    archived: false,
    open: r.status === "pending" || r.status === "verified",
    surface: "web",
    org: { slug: r.orgSlug, name: r.orgName, domain: r.orgDomain },
  }));
}

async function countOpen(db: Db): Promise<Record<SubmissionKind, number>> {
  const one = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  const [rec, fb, tracking, claim] = await Promise.all([
    one(db.select({ n: count() }).from(recommendations).where(recOpen)),
    one(db.select({ n: count() }).from(feedback).where(fbOpen)),
    one(db.select({ n: count() }).from(organizations).where(trackingOpen)),
    one(db.select({ n: count() }).from(orgClaims).where(claimOpen)),
  ]);
  return { recommendation: rec, feedback: fb, "tracking-request": tracking, claim };
}

adminSubmissionRoutes.get("/admin/submissions", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));
  const openOnly = c.req.query("state") !== "all";
  const kindParam = c.req.query("kind");
  const kind = (SUBMISSION_KINDS as readonly string[]).includes(kindParam ?? "")
    ? (kindParam as SubmissionKind)
    : null;

  const loaders: Record<SubmissionKind, () => Promise<SubmissionItem[]>> = {
    recommendation: () => loadRecommendations(db, openOnly, limit),
    feedback: () => loadFeedback(db, openOnly, limit),
    "tracking-request": () => loadTrackingRequests(db, openOnly, limit),
    claim: () => loadClaims(db, openOnly, limit),
  };
  const selected: SubmissionKind[] = kind ? [kind] : [...SUBMISSION_KINDS];

  const [lists, openCounts] = await Promise.all([
    Promise.all(selected.map((k) => loaders[k]())),
    countOpen(db),
  ]);

  // Each per-kind query is already newest-first and capped at `limit`, so the
  // merged top-`limit` is exact.
  const items = lists
    .flat()
    .toSorted((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, limit);

  const body: SubmissionsResponse = { items, openCounts };
  return c.json(body);
});
