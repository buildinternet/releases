/**
 * Nightly stale OAuth-client reaper (DCR follow-up to #1510).
 *
 * Dynamic client registration (RFC 7591) lets anyone self-register an OAuth
 * client at the public `/oauth2/register` endpoint, so abandoned registrations
 * — created by a probe / MCP Inspector / agent that registered but never
 * completed an authorization — accumulate as `oauth_client` rows. This sweep
 * purges them.
 *
 * A client is REAPABLE only when ALL hold:
 *   - older than the retention window (default 30d, `OAUTH_CLIENT_REAPER_RETENTION_DAYS`),
 *   - NOT trusted (`skip_consent` ≠ 1) — first-party/admin clients are never touched,
 *   - has ZERO `oauth_consent` rows AND zero token rows — i.e. no user ever
 *     authorized it. Consent persists across token expiry, so it is the durable
 *     "was authorized" signal; the token tables are belt-and-suspenders.
 *
 * Gated by the `oauth-client-reaper-enabled` flag. OFF (default) → OBSERVE-ONLY:
 * the reapable set is computed and logged (Axiom, `event: oauth-client-reaper`,
 * `mode: observe`) but nothing is deleted, so you can review candidates before
 * flipping to delete. ON → the candidates are deleted.
 *
 * Runs at 07:00 UTC daily — sequenced after well-known-sync (06:00) so the daily
 * sweeps don't compete for D1 capacity.
 */

import { and, lt, or, eq, isNull, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import {
  oauthClient,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
} from "../db/schema-auth.js";
import { finalizeRunRow, insertRunningRow, reconcileStaleRunning } from "../db/cron-runs-dao.js";

export const CRON_NAME = "sweep-oauth-clients";
export const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_DAYS = 30;
/** Cap the client_id sample logged per run so the audit line stays lean. */
const CLIENT_ID_LOG_SAMPLE = 50;
/** D1 allows ≤100 bound params per statement; chunk id-lists well under that. */
const DELETE_CHUNK = 90;

export type SweepOauthClientsEnv = {
  DB: D1Database;
  CRON_ENABLED?: string;
  FLAGS?: FlagshipBinding;
  OAUTH_CLIENT_REAPER_ENABLED?: string;
  OAUTH_CLIENT_REAPER_RETENTION_DAYS?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  // oxlint-disable-next-line no-explicit-any -- test seam, mirrors sibling sweeps
  _drizzleOverride?: any;
};

function parseRetentionDays(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export async function sweepOauthClients(env: SweepOauthClientsEnv): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[sweep-oauth-clients] CRON_ENABLED=false; skipping");
    return;
  }

  const db = env._drizzleOverride ?? drizzle(env.DB);
  const now = new Date();
  const retentionDays = parseRetentionDays(env.OAUTH_CLIENT_REAPER_RETENTION_DAYS);
  // `oauth_client.created_at` is an integer-timestamp column (schema-auth uses
  // unix-int timestamps, unlike core's ISO-text), so compare against a Date —
  // drizzle serializes it to the column's unit. (daysAgoIso() would be wrong here.)
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleteEnabled = await flag(
    env.FLAGS,
    env.OAUTH_CLIENT_REAPER_ENABLED,
    FLAGS.oauthClientReaperEnabled,
  );

  await reconcileStaleRunning(db, {
    cronName: CRON_NAME,
    now,
    thresholdMs: STALE_RUNNING_THRESHOLD_MS,
  });
  const runId = await insertRunningRow(db, { cronName: CRON_NAME, startedAt: now.toISOString() });

  try {
    // Candidates: registered before the cutoff and NOT trusted (skip_consent).
    const candidates: { id: string; clientId: string }[] = await db
      .select({ id: oauthClient.id, clientId: oauthClient.clientId })
      .from(oauthClient)
      .where(
        and(
          lt(oauthClient.createdAt, cutoff),
          or(isNull(oauthClient.skipConsent), eq(oauthClient.skipConsent, false)),
        ),
      );

    // Build the "in use" client_id set (ever consented OR holding any token).
    // Done as plain reads + a JS Set rather than NOT IN (subquery) to avoid
    // SQLite's NOT-IN-with-NULL trap and keep the predicate trivially testable.
    // The oauth_* tables are small (low thousands at most).
    const inUse = new Set<string>();
    for (const table of [oauthConsent, oauthAccessToken, oauthRefreshToken]) {
      // oxlint-disable-next-line no-await-in-loop -- three small lookups; sequential is fine
      const rows: { clientId: string }[] = await db
        .select({ clientId: table.clientId })
        .from(table);
      for (const r of rows) inUse.add(r.clientId);
    }

    const reapable = candidates.filter((c) => !inUse.has(c.clientId));

    let deleted = 0;
    if (deleteEnabled && reapable.length > 0) {
      const ids = reapable.map((c) => c.id);
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        // oxlint-disable-next-line no-await-in-loop -- chunked delete under D1's bind cap
        const res = await db
          .delete(oauthClient)
          .where(inArray(oauthClient.id, ids.slice(i, i + DELETE_CHUNK)))
          .returning({ id: oauthClient.id });
        deleted += res.length;
      }
    }

    const mode = deleteEnabled ? "delete" : "observe";
    logEvent("info", {
      component: "auth",
      event: "oauth-client-reaper",
      mode,
      retentionDays,
      reapable: reapable.length,
      deleted,
      clientIds: reapable.slice(0, CLIENT_ID_LOG_SAMPLE).map((c) => c.clientId),
    });

    const notes = `mode=${mode} reapable=${reapable.length} deleted=${deleted} (untrusted, no consent/tokens, older than ${retentionDays}d)`;
    await finalizeRunRow(db, runId, {
      endedAt: new Date().toISOString(),
      status: "done",
      candidates: reapable.length,
      dispatched: deleted,
      skippedOverCap: 0,
      dispatchErrors: 0,
      sessionsStarted: [],
      dispatchErrorDetail: [],
      notes,
    });
    console.log(`[sweep-oauth-clients] done: ${notes}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finalizeRunRow(db, runId, {
      endedAt: new Date().toISOString(),
      status: "aborted",
      abortReason: "config_missing",
      candidates: 0,
      dispatched: 0,
      skippedOverCap: 0,
      dispatchErrors: 1,
      sessionsStarted: [],
      dispatchErrorDetail: [{ orgSlug: "n/a", error: message }],
      notes: `oauth-client reaper failed: ${message}`,
    });
    throw err;
  }
}
