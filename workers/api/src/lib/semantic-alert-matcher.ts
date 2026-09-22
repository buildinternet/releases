import type { D1Db } from "../db.js";

/**
 * One alert scored against one release. Phase 2 fills `probability` from the
 * JEV selected-choice score. `matched` is probability >= the alert threshold.
 */
export interface SemanticAlertMatchHit {
  alertId: string;
  releaseId: string;
  probability: number | null;
  matched: boolean;
  threshold: number;
}

export interface SemanticAlertMatchPreview {
  /**
   * `unavailable` until Phase 2 replaces {@link matchSemanticAlertsForUser}.
   * `scored` once the matcher ran (including an empty candidate set).
   */
  status: "unavailable" | "scored";
  reason?: string;
  matches: SemanticAlertMatchHit[];
}

/** Release text the matcher is allowed to see. Public changelog fields only. */
export interface SemanticAlertMatchRelease {
  id: string;
  title: string;
  content: string;
  sourceId: string;
  orgId: string | null;
}

/**
 * Phase 2 seam (#2304).
 *
 * The admin preview calls this after a real insert and `publishReleaseEvents`.
 * Replace this body with the JEV matcher: follows-only prefilter, one call per
 * release, multiple `noul` questions, fail closed. Do not log alert query text
 * and do not write it to Analytics Engine.
 *
 * Returning `{ status: "unavailable" }` is the Phase 1 behavior. The preview
 * route still confirms inserts and events.
 */
export async function matchSemanticAlertsForUser(
  _db: D1Db,
  _userId: string,
  _releases: SemanticAlertMatchRelease[],
): Promise<SemanticAlertMatchPreview> {
  return { status: "unavailable", reason: "matcher_not_wired", matches: [] };
}
