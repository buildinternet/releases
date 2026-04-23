/**
 * Identifies our bot to third-party sites we fetch from (changelog pages,
 * feeds, GitHub, provider probes). Consumed by every outbound fetch in the
 * adapters, the evaluator, the provider-detection probe, and the API worker's
 * cron fetch paths so that site operators see one consistent string and can
 * allowlist or contact us.
 *
 * Not used for our own service-to-service traffic — web→API and
 * discovery→API use `releases-web` / `releases-discovery-worker` instead so
 * they're distinguishable from outbound scraping in Cloudflare Analytics.
 */
export const RELEASES_BOT_UA = "releases/0.1 (+https://releases.sh)";
