// Detection for Cloudflare challenge interstitials. Kept in its own module
// (separate from cloudflare.ts, which does the network fetch) so worker tests
// can mock the impure fetch via `mock.module("@releases/adapters/cloudflare")`
// without clobbering this pure detector. See issue #1171.

// Source-level markers from Cloudflare's challenge-platform. These never appear
// in a real article body, so any hit is conclusive. We check them too in case
// the HTML→markdown converter preserves inline script/href text.
const CF_CHALLENGE_SOURCE_MARKERS = [
  "_cf_chl_opt",
  "cdn-cgi/challenge-platform",
  "cf-browser-verification",
] as const;

// Visible interstitial copy that survives HTML→markdown. Each phrase is
// challenge-specific — distinct enough that a legitimate changelog mentioning
// "Cloudflare" or a "Ray ID" won't match. Datacenter-IP renders (our Browser
// Rendering egress) hit "verifying you are human"; a JS-disabled fetch hits
// "enable javascript and cookies".
const CF_CHALLENGE_INTERSTITIAL_PHRASES = [
  "enable javascript and cookies to continue",
  "verifying you are human",
  "checking your browser before accessing",
  "needs to review the security of your connection before proceeding",
] as const;

/**
 * Detect whether rendered content is a Cloudflare challenge interstitial rather
 * than the page we asked for. Cloudflare Browser Rendering egresses from
 * datacenter IPs, so a Managed Challenge serves it the "verifying you are human"
 * interstitial, which extracts to zero releases and silently logs `no_change`.
 * Callers short-circuit on a `true` here to a distinct `blocked` signal instead
 * of running extraction on the interstitial. See issue #1171.
 */
export function isCloudflareChallengePage(content: string): boolean {
  if (!content) return false;
  const haystack = content.toLowerCase();
  return (
    CF_CHALLENGE_SOURCE_MARKERS.some((m) => haystack.includes(m)) ||
    CF_CHALLENGE_INTERSTITIAL_PHRASES.some((p) => haystack.includes(p))
  );
}
