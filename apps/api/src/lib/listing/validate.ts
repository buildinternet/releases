import {
  ReleasesJsonDomainSchema,
  type ListingValidationResult,
  type ListingLocation,
  type ReleasesJsonDomain,
} from "@buildinternet/releases-api-types";
import { toSlug } from "@buildinternet/releases-core/slug";
import { fetchReleasesJson } from "../well-known/fetch.js";
import { classifyLocation, type DeclaredLocation } from "../well-known/materialize.js";
import { resolveDomainOrg } from "../well-known/stub.js";
import type { createDb } from "../../db.js";

type Db = ReturnType<typeof createDb>;

/** Same normalization createStubFromManifest applies to its raw domain. */
export function normalizeListingDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/\.+$/, "");
  if (domain.length === 0 || !/^[a-z0-9.-]+$/.test(domain)) return null;
  return domain;
}

const BECOMES: Record<"tier1" | "tier2", string> = {
  tier1: "Live source when tracked",
  tier2: "Queued for curator review when tracked",
};

function locatorKind(loc: DeclaredLocation): ListingLocation["kind"] {
  if (loc.feed) return "feed";
  if (loc.github) return "github";
  if (loc.appstore) return "appstore";
  if (loc.file) return "file";
  return "url";
}

function toListingLocation(loc: DeclaredLocation, productName?: string): ListingLocation {
  const classified = classifyLocation(loc);
  return {
    locator: classified.locator,
    kind: locatorKind(loc),
    classification: classified.tier === 1 ? "tier1-live" : "tier2-paused-review",
    becomes: classified.tier === 1 ? BECOMES.tier1 : BECOMES.tier2,
    ...(productName ? { productName } : {}),
  };
}

/** Human-readable fetch-failure copy keyed by FetchSkipReason. */
const FETCH_ERROR: Record<string, string> = {
  blocked: "That domain can't be fetched (blocked or not publicly reachable over HTTPS).",
  not_found: "No releases.json found at /.well-known/releases.json on that domain.",
  http_error: "Fetching /.well-known/releases.json returned an HTTP error.",
  network_error: "Could not reach that domain to fetch /.well-known/releases.json.",
  too_large: "releases.json is larger than the 64KB limit.",
  invalid_json: "releases.json is not valid JSON.",
};

export async function validateListing(
  db: Db,
  rawDomain: string,
  opts: {
    webBaseUrl: string;
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  } = { webBaseUrl: "https://releases.sh" },
): Promise<ListingValidationResult> {
  const domain = normalizeListingDomain(rawDomain);
  if (!domain) {
    return {
      valid: false,
      errors: [{ path: "domain", message: "Not a valid domain name." }],
      domainStatus: "unlisted",
      locations: [],
    };
  }

  const existing = await resolveDomainOrg(db, domain);
  const domainStatus: ListingValidationResult["domainStatus"] = existing
    ? existing.tier === "stub"
      ? "stub"
      : "listed"
    : "unlisted";
  const org = existing
    ? { slug: existing.slug, name: existing.name, webUrl: `${opts.webBaseUrl}/${existing.slug}` }
    : undefined;

  const fetched = await fetchReleasesJson(`https://${domain}/.well-known/releases.json`, {
    fetchImpl: opts.fetchImpl,
  });
  if (!fetched.ok) {
    return {
      valid: false,
      errors: [{ path: "", message: FETCH_ERROR[fetched.reason] ?? FETCH_ERROR.network_error! }],
      domainStatus,
      ...(org ? { org } : {}),
      locations: [],
    };
  }

  const parsed = ReleasesJsonDomainSchema.safeParse(fetched.json);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      domainStatus,
      ...(org ? { org } : {}),
      locations: [],
    };
  }

  const manifest: ReleasesJsonDomain = parsed.data;
  const name = manifest.name ?? domain;
  const locations: ListingLocation[] = [
    ...(manifest.products ?? []).flatMap((p) =>
      (p.releases ?? []).map((r) => toListingLocation(r as DeclaredLocation, p.name)),
    ),
    ...(manifest.releases ?? []).map((r) => toListingLocation(r as DeclaredLocation)),
  ];

  return {
    valid: true,
    errors: [],
    domainStatus,
    ...(org ? { org } : {}),
    identity: { name, slug: toSlug(name), domain },
    products: (manifest.products ?? []).map((p) => ({
      name: p.name,
      locationCount: (p.releases ?? []).length,
    })),
    locations,
  };
}
