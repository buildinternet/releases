/**
 * Identity headers for outbound HTTP fetches from the discovery worker to the
 * API worker. Service-binding calls (`env.API_WORKER.fetch`) bypass the edge
 * and these headers are purely informational; the fallback HTTP path hits the
 * public edge, where these surface in Cloudflare Analytics alongside
 * `releases-web` traffic from Vercel.
 */

export const DISCOVERY_USER_AGENT = "releases-discovery-worker";
export const DISCOVERY_REQUESTED_WITH = "releases-discovery-worker";

export function discoveryIdentityHeaders(): Record<string, string> {
  return {
    "User-Agent": DISCOVERY_USER_AGENT,
    "X-Requested-With": DISCOVERY_REQUESTED_WITH,
  };
}
