/**
 * Identifies our bot to third-party sites we fetch from (changelog pages,
 * feeds, GitHub, provider probes). Consumed by every outbound fetch in the
 * adapters, the evaluator, the provider-detection probe, and the API worker's
 * cron fetch paths so that site operators see one consistent string and can
 * allowlist or contact us.
 *
 * Not used for our own service-to-service traffic — web→API uses
 * `releases-web` instead so it's distinguishable from outbound scraping in
 * Cloudflare Analytics.
 */
export { WEB_BOT_AUTH_USER_AGENT as RELEASES_BOT_UA } from "@buildinternet/releases-core/web-bot-auth";
