/**
 * Escape the five HTML-significant chars for safe interpolation into markup.
 * Shared by the worker-side HTML email/report builders (digest emails, cron
 * reports, poll-fetch alerts) so the escaping is defined once.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
