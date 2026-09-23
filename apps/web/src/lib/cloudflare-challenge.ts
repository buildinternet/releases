/** Heuristic for Cloudflare edge managed-challenge HTML (not a worker JSON error). */
export function isCloudflareChallengeBody(contentType: string | null, body: ArrayBuffer): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (!type.includes("text/html")) return false;
  const text = new TextDecoder().decode(body.slice(0, 4096)).toLowerCase();
  return (
    text.includes("just a moment") ||
    text.includes("challenges.cloudflare.com") ||
    text.includes("cf-chl") ||
    text.includes("enable javascript and cookies")
  );
}
