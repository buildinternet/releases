/**
 * Browser client for owner-minted publish tokens (`/v1/me/publish-tokens` on
 * the API worker, #2373). These routes are cookie-session only and refuse a
 * mint/revoke whose `Origin` isn't exactly the web origin, so they must be
 * called from the browser with `credentials: "include"` — a server-side proxy
 * would fail the origin check.
 *
 * `null` from {@link listPublishTokens} / {@link listPublishableSources} means
 * the lane is off (the listing kill switch 404s both surfaces); the panel
 * renders nothing in that case.
 */

import type {
  CreatedPublishToken,
  ListPublishTokensResponse,
  ListingClaimsResult,
  OrgDetail,
  PublishToken,
} from "@buildinternet/releases-api-types";
import { apiBase, errorMessage } from "./user-api";
export type { CreatedPublishToken, PublishToken };

/** One source a verified owner can bind a token to, grouped by org in the picker. */
export type PublishableSource = {
  id: string;
  name: string;
  slug: string;
  orgSlug: string;
  orgName: string;
};

export async function listPublishTokens(): Promise<PublishToken[] | null> {
  const res = await fetch(`${apiBase()}/v1/me/publish-tokens`, { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load publish tokens (${res.status})`));
  }
  return ((await res.json()) as ListPublishTokensResponse).publishTokens;
}

export async function createPublishToken(input: {
  sourceId: string;
  name: string;
}): Promise<CreatedPublishToken> {
  const res = await fetch(`${apiBase()}/v1/me/publish-tokens`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to create publish token (${res.status})`));
  }
  return (await res.json()) as CreatedPublishToken;
}

export async function revokePublishToken(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/me/publish-tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to revoke publish token (${res.status})`));
  }
}

/**
 * Sources the caller may mint a token for: every source of every org they hold
 * a VERIFIED claim on. Pending and expired claims don't count — the mint route
 * would 403. Org details are public reads, fetched in parallel; an org that
 * fails to load is skipped rather than failing the whole picker.
 */
export async function listPublishableSources(): Promise<{
  verifiedOrgCount: number;
  sources: PublishableSource[];
} | null> {
  const res = await fetch(`${apiBase()}/v1/listing/claims`, { credentials: "include" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await errorMessage(res, "Could not load your ownership claims."));
  const { claims } = (await res.json()) as ListingClaimsResult;

  const orgs = [
    ...new Map(
      claims.filter((c) => c.status === "verified").map((c) => [c.org.slug, c.org]),
    ).values(),
  ];
  const details = await Promise.all(
    orgs.map(async (org) => {
      try {
        const r = await fetch(`${apiBase()}/v1/orgs/${encodeURIComponent(org.slug)}`);
        return r.ok ? { org, detail: (await r.json()) as OrgDetail } : null;
      } catch {
        return null;
      }
    }),
  );

  const sources = details.flatMap((d) =>
    d
      ? d.detail.sources.flatMap((s) =>
          s.id
            ? [{ id: s.id, name: s.name, slug: s.slug, orgSlug: d.org.slug, orgName: d.org.name }]
            : [],
        )
      : [],
  );
  return { verifiedOrgCount: orgs.length, sources };
}

/** The GitHub Actions step an owner pastes after minting (matches the docs example). */
export function publishWorkflowSnippet(sourceId: string): string {
  return [
    "- uses: buildinternet/releases/actions/publish-changelog@main",
    "  with:",
    `    source: ${sourceId}`,
    "    api-token: ${{ secrets.RELEASES_API_TOKEN }}",
  ].join("\n");
}
