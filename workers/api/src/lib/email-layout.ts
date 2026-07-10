/**
 * Shared footer + light HTML shell for transactional email bodies. Keeps the
 * "why you got this" copy and preference links consistent across auth, digest,
 * and acknowledgment mail.
 */
import { escapeHtml } from "./html-escape.js";

export type EmailFooterLink = {
  label: string;
  href: string;
};

export type EmailFooterOpts = {
  /** One sentence explaining why the recipient received this message. */
  reason: string;
  links?: EmailFooterLink[];
};

const TEXT_DIVIDER = "—";

/** Append a plain-text footer block (reason + optional links). */
export function appendTextFooter(body: string, opts: EmailFooterOpts): string {
  const lines = ["", TEXT_DIVIDER, opts.reason];
  for (const link of opts.links ?? []) {
    lines.push(`${link.label}: ${link.href}`);
  }
  lines.push("", "Releases · https://releases.sh");
  return `${body.trimEnd()}\n${lines.join("\n")}`;
}

/** Append an HTML footer (reason + optional links) after existing body markup. */
export function appendHtmlFooter(bodyHtml: string, opts: EmailFooterOpts): string {
  const linkBits = (opts.links ?? [])
    .map(
      (l) =>
        `<a href="${escapeHtml(l.href)}" style="color:#64748b;text-decoration:underline;">${escapeHtml(l.label)}</a>`,
    )
    .join(" · ");
  const linksRow = linkBits
    ? `<p style="font:12px system-ui,sans-serif;color:#64748b;margin:8px 0 0;">${linkBits}</p>`
    : "";
  return (
    `${bodyHtml.trimEnd()}` +
    `<hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;">` +
    `<p style="font:12px system-ui,sans-serif;color:#64748b;margin:0;line-height:1.5;">${escapeHtml(opts.reason)}</p>` +
    linksRow +
    `<p style="font:12px system-ui,sans-serif;color:#94a3b8;margin:12px 0 0;">Releases · <a href="https://releases.sh" style="color:#94a3b8;">releases.sh</a></p>`
  );
}

/**
 * Minimal HTML document wrapper for single-column transactional mail. `margin:0 auto`
 * centers the column in a wide reading pane; the `max-width` keeps the measure
 * readable rather than letting lines run the full width of the window.
 */
export function wrapHtmlEmail(inner: string): string {
  return (
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;` +
    `max-width:560px;line-height:1.5;margin:0 auto;padding:16px;">${inner}</body></html>`
  );
}
