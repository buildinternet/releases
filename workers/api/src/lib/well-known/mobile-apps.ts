import { eq, sql } from "drizzle-orm";
import { organizations } from "@buildinternet/releases-core/schema";
import {
  parseAppSiteAssociation,
  parseAssetLinks,
  playStoreUrl,
} from "@releases/adapters/app-links";
import { resolveAppStoreByBundleId } from "@releases/adapters/appstore";
import { logEvent } from "@releases/lib/log-event";
import { fetchReleasesJson } from "./fetch.js";
import { materializeAppStoreSource } from "../appstore-materialize.js";
import type { createDb } from "../../db.js";

type Db = ReturnType<typeof createDb>;

/**
 * Discover a domain's native mobile apps from the two platform "app links"
 * well-known files it publishes (AASA + assetlinks.json), then:
 *
 * - **iOS:** resolve each declared bundle ID via the iTunes Lookup API and land
 *   a **paused, hidden** `appstore` source candidate under the org — a curator
 *   reviews and unpauses to make it live. Idempotent on the App Store trackId.
 * - **Android:** there is no `playstore` source type, so package names are
 *   stored as a display-only hint under `org.metadata.discoveredApps.android`.
 *
 * Fail-closed throughout: every fetch is SSRF-screened + capped (never throws),
 * and materialization only happens when `enabled` is true and not a dry run.
 * These files are published intentionally for machine consumption, so probing
 * them carries no crawl-consent ambiguity.
 */

const DEFAULT_MAX_APPS_PER_ORG = 5;

export interface DiscoverMobileAppsOptions {
  /** The org's domain; files are fetched from `https://{domain}/.well-known/…`.
   *  A missing domain is a safe no-op (`skippedReason: "no_domain"`). */
  domain: string | null | undefined;
  storefront?: string;
  /** Cap on iTunes lookups per org (bounds subrequests). Default 5. */
  maxAppsPerOrg?: number;
  /** Materialization gate (the well-known-materialization flag). When false, no
   *  writes AND no iTunes resolution — declared apps are reported as gated. */
  enabled?: boolean;
  /** Resolve + report the plan without writing anything. */
  dryRun?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export type IosCandidateAction =
  | "created" // new paused+hidden candidate source
  | "existing" // an appstore source for this app already exists
  | "not_found" // iTunes had no listing for the bundle id
  | "gated"; // materialization disabled — not resolved

export interface DiscoveredIosApp {
  bundleId: string;
  action: IosCandidateAction;
  trackId?: string;
  trackViewUrl?: string;
  sourceId?: string;
}

export interface DiscoveredAndroidApp {
  packageName: string;
  playUrl: string;
}

export interface MobileDiscoveryResult {
  fetched: { aasa: boolean; assetlinks: boolean };
  ios: DiscoveredIosApp[];
  android: DiscoveredAndroidApp[];
  /** True if any DB write happened (candidate created or hint stored). */
  applied: boolean;
  skippedReason?: "no_domain" | "invalid_domain";
}

/** Charset-harden the domain before interpolating it into a URL (mirrors
 *  reconcile-org.ts). fetchReleasesJson additionally enforces https + the SSRF
 *  host screen + manual redirects. */
function normalizeProbeDomain(domain: string): string | null {
  const d = domain.toLowerCase().replace(/\.+$/, "");
  return /^[a-z0-9.-]+$/.test(d) ? d : null;
}

export async function discoverMobileApps(
  db: Db,
  orgId: string,
  opts: DiscoverMobileAppsOptions,
): Promise<MobileDiscoveryResult> {
  const empty: MobileDiscoveryResult = {
    fetched: { aasa: false, assetlinks: false },
    ios: [],
    android: [],
    applied: false,
  };

  if (!opts.domain) return { ...empty, skippedReason: "no_domain" };
  const domain = normalizeProbeDomain(opts.domain);
  if (!domain) {
    logEvent("warn", {
      component: "mobile-discovery",
      event: "invalid-domain",
      orgId,
      domain: opts.domain,
    });
    return { ...empty, skippedReason: "invalid_domain" };
  }

  // Callers (the sweep cron and the on-demand route) always pass an existing
  // orgId; a dangling id would fail the sources FK at insert time anyway, so no
  // pre-check round-trip.
  const storefront = opts.storefront ?? "us";
  const maxApps = opts.maxAppsPerOrg ?? DEFAULT_MAX_APPS_PER_ORG;
  const enabled = opts.enabled !== false;
  const dryRun = opts.dryRun === true;
  const canWrite = enabled && !dryRun;

  // Both well-known files are independent GETs to the same host — fetch them
  // together. (The per-bundle-ID iTunes lookups below stay sequential to bound
  // the Cloudflare subrequest budget.)
  const [aasa, assetlinks] = await Promise.all([
    fetchReleasesJson(`https://${domain}/.well-known/apple-app-site-association`, {
      fetchImpl: opts.fetchImpl,
    }),
    fetchReleasesJson(`https://${domain}/.well-known/assetlinks.json`, {
      fetchImpl: opts.fetchImpl,
    }),
  ]);
  const bundleIds = aasa.ok ? parseAppSiteAssociation(aasa.json).bundleIds : [];
  const packageNames = assetlinks.ok ? parseAssetLinks(assetlinks.json).packageNames : [];

  const android: DiscoveredAndroidApp[] = packageNames.map((packageName) => ({
    packageName,
    playUrl: playStoreUrl(packageName),
  }));

  // ── iOS candidates ──────────────────────────────────────────────────────
  const ios: DiscoveredIosApp[] = [];
  let applied = false;
  const capped = bundleIds.slice(0, maxApps);
  if (!enabled) {
    // Materialization gated off — report the declared apps without resolving.
    for (const bundleId of capped) ios.push({ bundleId, action: "gated" });
  } else {
    for (const bundleId of capped) {
      // oxlint-disable-next-line no-await-in-loop -- sequential to bound iTunes subrequests
      const listing = await resolveAppStoreByBundleId(bundleId, { storefront, platform: "ios" });
      if (!listing) {
        ios.push({ bundleId, action: "not_found" });
        continue;
      }
      const trackId = String(listing.trackId);
      const trackViewUrl = listing.trackViewUrl;
      if (dryRun) {
        ios.push({ bundleId, action: "created", trackId, trackViewUrl });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential per-app candidate creation
      const result = await materializeAppStoreSource(db, {
        identifier: trackId,
        orgId,
        storefront,
        platform: "ios",
        discovery: "on_demand",
        isHidden: true,
        fetchPriority: "paused",
        preResolved: { listing, coord: { trackId, platform: "ios", storefront } },
      });
      if (result.status === "indexed") {
        applied = true;
        ios.push({
          bundleId,
          action: "created",
          trackId,
          trackViewUrl,
          sourceId: result.source.id,
        });
      } else if (result.status === "existing") {
        ios.push({
          bundleId,
          action: "existing",
          trackId,
          trackViewUrl,
          sourceId: result.source.id,
        });
      } else {
        ios.push({ bundleId, action: "not_found", trackId });
      }
    }
  }

  // Store the current app inventory as a display-only hint. Overwrite (not
  // append) so it always reflects the latest well-known state; `json_set`
  // patches only `$.discoveredApps`, never clobbering sibling metadata keys
  // (selfDeclared, wellKnownSweptAt, mobileAppsSweptAt).
  if (canWrite && (ios.length > 0 || android.length > 0)) {
    const hint = {
      ios: ios
        .filter((a) => a.trackId)
        .map((a) => ({ bundleId: a.bundleId, trackId: a.trackId, sourceId: a.sourceId })),
      android,
    };
    try {
      await db
        .update(organizations)
        .set({
          metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.discoveredApps', json(${JSON.stringify(hint)}))`,
        })
        .where(eq(organizations.id, orgId));
      applied = true;
    } catch (err) {
      logEvent("warn", {
        component: "mobile-discovery",
        event: "hint-write-failed",
        orgId,
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  logEvent("info", {
    component: "mobile-discovery",
    event: "probed",
    orgId,
    domain,
    aasaFound: aasa.ok,
    assetlinksFound: assetlinks.ok,
    iosDeclared: bundleIds.length,
    iosCandidates: ios.filter((a) => a.action === "created").length,
    androidHints: android.length,
    dryRun,
    enabled,
  });

  return {
    fetched: { aasa: aasa.ok, assetlinks: assetlinks.ok },
    ios,
    android,
    applied,
  };
}
