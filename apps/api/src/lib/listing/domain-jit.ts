/**
 * Just-in-time domain-manifest discovery (#2030): on a by-domain lookup miss,
 * optionally fetch /.well-known/releases.json and materialize a stub via
 * createStubFromManifest. Synchronous counterpart to domainDemandSweep.
 *
 * Abuse brakes: per-IP CF limiter on the outbound branch, plus a per-domain
 * probe budget in LATEST_CACHE (3 probes / ~10 min sliding window) so owners
 * can retry a broken manifest without enabling unlimited third-party fetches.
 */
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import type { D1Db } from "../../db.js";
import { makeBotFetch, type WebBotAuthEnv } from "../web-bot-auth-fetch.js";
import { createStubFromManifest } from "../well-known/stub.js";

/** Sliding window for the per-domain outbound probe budget. */
export const DOMAIN_MANIFEST_PROBE_WINDOW_SECONDS = 10 * 60;
export const DOMAIN_MANIFEST_PROBE_MAX = 3;

export type DomainJitResult = "materialized" | "rate_limited" | "miss";

export interface DomainJitEnv extends WebBotAuthEnv {
  FLAGS?: FlagshipBinding;
  LISTING_SELF_SERVE_ENABLED?: string;
  LISTING_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  LATEST_CACHE?: KVNamespace;
  /** TEST-ONLY: inject fetch (skips makeBotFetch). */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

function probeKey(domain: string): string {
  return `lookup:domain-manifest:${domain.toLowerCase()}`;
}

/**
 * Consume one outbound probe slot for `domain`. Fail-open when KV is unbound.
 * Each allow writes/extends a sliding TTL window; concurrent races can overshoot
 * slightly — acceptable for this abuse brake.
 */
export async function consumeDomainManifestProbeBudget(
  kv: KVNamespace | undefined,
  domain: string,
): Promise<"allow" | "exhausted"> {
  if (!kv) return "allow";
  const k = probeKey(domain);
  let count = 0;
  const raw = await kv.get(k);
  if (raw) {
    try {
      const n = (JSON.parse(raw) as { count?: unknown }).count;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) count = n;
    } catch {
      // Malformed — treat as empty and overwrite.
    }
  }
  if (count >= DOMAIN_MANIFEST_PROBE_MAX) return "exhausted";
  await kv.put(k, JSON.stringify({ count: count + 1 }), {
    expirationTtl: DOMAIN_MANIFEST_PROBE_WINDOW_SECONDS,
  });
  return "allow";
}

/**
 * Attempt in-request stub materialization for an unlisted domain.
 * Caller records domain_demand and re-resolves when the result is `"materialized"`.
 */
export async function tryDomainManifestJit(
  env: DomainJitEnv,
  db: D1Db,
  domain: string,
  opts: { ip?: string } = {},
): Promise<DomainJitResult> {
  const enabled = await flag(
    env.FLAGS,
    env.LISTING_SELF_SERVE_ENABLED,
    FLAGS.listingSelfServeEnabled,
  );
  if (!enabled) return "miss";

  if (env.LISTING_RATE_LIMITER) {
    const ip = opts.ip ?? "unknown";
    const { success } = await env.LISTING_RATE_LIMITER.limit({ key: `domain-jit:${ip}` });
    if (!success) {
      logEvent("info", {
        component: "listing",
        event: "domain-jit-skip",
        domain,
        reason: "rate_limited",
        ip,
      });
      return "rate_limited";
    }
  }

  if ((await consumeDomainManifestProbeBudget(env.LATEST_CACHE, domain)) === "exhausted") {
    logEvent("info", {
      component: "listing",
      event: "domain-jit-skip",
      domain,
      reason: "probe_budget",
    });
    return "miss";
  }

  try {
    const fetchImpl = env.fetchImpl ?? (await makeBotFetch(env));
    const result = await createStubFromManifest(db, domain, { fetchImpl });

    // created, or a concurrent create already owns the domain — caller re-resolves.
    if (result.created || result.skippedReason === "org_exists") {
      logEvent("info", {
        component: "listing",
        event: "domain-jit-stub-created",
        domain,
        orgId: result.orgId,
        locationCount: result.locationCount,
        raced: !result.created,
      });
      return "materialized";
    }

    logEvent("info", {
      component: "listing",
      event: "domain-jit-skip",
      domain,
      reason: result.skippedReason ?? "unknown",
    });
    return "miss";
  } catch (err) {
    logEvent("error", {
      component: "listing",
      event: "domain-jit-failed",
      domain,
      err: err instanceof Error ? err : String(err),
    });
    return "miss";
  }
}
