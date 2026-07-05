/**
 * Shared best-effort "arm the per-org drain" notify (#1946 phase 2).
 *
 * Every producer that sets `changeDetectedAt` on a scrape/agent source calls
 * this as it finishes so the `OrgActor` drain is armed in real time, instead of
 * waiting for the source's next `SourceActor` alarm to notice the flag (up to a
 * full tier interval later — the arming lag phase 2 removes). It's a plain DO
 * RPC now that the drain executes in-worker (no HTTP hop).
 *
 * Idempotent on the OrgActor side: `ensureDrainScheduled` only sets an alarm
 * when none is pending, so a duplicate notify — the eager poll-workflow path and
 * the `SourceActor` alarm backstop both firing for the same flag — is harmless.
 * Never throws: a failed drain-arm must not fail the caller's fetch/alarm; the
 * recurring `SourceActor` alarm re-notifies until the flag clears, so the safety
 * net covers a dropped RPC.
 */

import { logEvent } from "@releases/lib/log-event";
import type { OrgActor } from "../org-actor.js";

export async function notifyOrgDrain(
  orgActor: DurableObjectNamespace<OrgActor> | undefined,
  orgId: string,
  via: string,
): Promise<void> {
  if (!orgActor) return;
  try {
    await orgActor.getByName(orgId).ensureDrainScheduled(orgId);
  } catch (err) {
    logEvent("warn", {
      component: "org-drain-notify",
      event: "org-drain-notify-failed",
      orgId,
      via,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
