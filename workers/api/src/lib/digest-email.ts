import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import { escapeHtml } from "./html-escape.js";
import type { AuthEmailBinding } from "../auth/email.js";

export interface DigestEmailEnv {
  AUTH_EMAIL?: AuthEmailBinding;
  DIGEST_EMAIL_FROM?: string;
  ENVIRONMENT?: string;
}

export interface DigestEmailContent {
  recipientName: string | null;
  cadence: "daily" | "weekly";
  releases: ReleaseLatestItem[];
  /** Web origin, e.g. https://releases.sh — release/org links are built from it. */
  baseUrl: string;
  /** Manage-preferences URL (the /following page). */
  manageUrl: string;
  /** One-click unsubscribe URL (the reld_ token lane). */
  unsubscribeUrl: string;
}

export type DigestEmailInput = DigestEmailContent & { to: string };

const DEFAULT_FROM = "digests@releases.sh";
const FROM_NAME = "Releases";

function bestTitle(r: ReleaseLatestItem): string {
  return r.titleShort || r.titleGenerated || r.title || r.version || "Update";
}

function releaseUrl(baseUrl: string, r: ReleaseLatestItem): string {
  return `${baseUrl}/release/${r.id}`;
}

/** Group releases by owning org slug, preserving input (published-desc) order. */
function groupByOrg(
  releases: ReleaseLatestItem[],
): Array<{ orgSlug: string | null; orgName: string; items: ReleaseLatestItem[] }> {
  const groups = new Map<
    string,
    { orgSlug: string | null; orgName: string; items: ReleaseLatestItem[] }
  >();
  for (const r of releases) {
    const key = r.source.orgSlug ?? r.source.name;
    let g = groups.get(key);
    if (!g) {
      // Heading is the org's display name ("Cloudflare"), not a source name
      // ("Cloudflare workerd"). Fall back to the source name only when the
      // source has no owning org (orgName/orgSlug null).
      g = { orgSlug: r.source.orgSlug, orgName: r.source.orgName ?? r.source.name, items: [] };
      groups.set(key, g);
    }
    g.items.push(r);
  }
  return [...groups.values()];
}

export function buildDigestEmail(content: DigestEmailContent): {
  subject: string;
  text: string;
  html: string;
} {
  const { releases, baseUrl, manageUrl, unsubscribeUrl, cadence } = content;
  const n = releases.length;
  const subject = `Your ${cadence} Releases digest — ${n} update${n === 1 ? "" : "s"}`;
  const groups = groupByOrg(releases);

  const textLines: string[] = [subject, ""];
  for (const g of groups) {
    textLines.push(g.orgName.toUpperCase());
    for (const r of g.items) {
      const prod = r.product ? ` (${r.product.name})` : "";
      textLines.push(`  • ${bestTitle(r)}${prod}`);
      if (r.summary) textLines.push(`    ${r.summary}`);
      textLines.push(`    ${releaseUrl(baseUrl, r)}`);
    }
    textLines.push("");
  }
  textLines.push("—");
  textLines.push(`Manage your digest: ${manageUrl}`);
  textLines.push(`Unsubscribe: ${unsubscribeUrl}`);
  const text = textLines.join("\n");

  const htmlParts: string[] = [
    `<h1 style="font:600 18px system-ui,sans-serif">${escapeHtml(subject)}</h1>`,
  ];
  for (const g of groups) {
    const orgHeading = g.orgSlug
      ? `<a href="${escapeHtml(`${baseUrl}/${g.orgSlug}`)}" style="color:#111;text-decoration:none">${escapeHtml(g.orgName)}</a>`
      : escapeHtml(g.orgName);
    htmlParts.push(
      `<h2 style="font:600 14px system-ui,sans-serif;margin-top:20px">${orgHeading}</h2>`,
    );
    for (const r of g.items) {
      const prod = r.product
        ? ` <span style="color:#888">(${escapeHtml(r.product.name)})</span>`
        : "";
      htmlParts.push(
        `<p style="margin:8px 0;font:14px system-ui,sans-serif">` +
          `<a href="${escapeHtml(releaseUrl(baseUrl, r))}" style="font-weight:600;color:#1a56db;text-decoration:none">${escapeHtml(bestTitle(r))}</a>${prod}` +
          (r.summary ? `<br><span style="color:#444">${escapeHtml(r.summary)}</span>` : "") +
          `</p>`,
      );
    }
  }
  htmlParts.push(
    `<hr style="margin-top:24px;border:none;border-top:1px solid #eee">` +
      `<p style="font:12px system-ui,sans-serif;color:#888">` +
      `<a href="${escapeHtml(manageUrl)}" style="color:#888">Manage your digest</a> · ` +
      `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p>`,
  );
  const html = htmlParts.join("");

  return { subject, text, html };
}

/**
 * Render + send a digest through the Cloudflare Email Sending binding. Never throws
 * — a missing binding or send error degrades to a logged `{ sent: false }` so the
 * cron loop can fire-and-forget per recipient. Adds RFC 8058 List-Unsubscribe
 * headers for one-click unsubscribe.
 */
export async function sendDigestEmail(
  env: DigestEmailEnv,
  input: DigestEmailInput,
): Promise<{ sent: boolean; reason?: "no_binding" | "error" }> {
  const { subject, text, html } = buildDigestEmail(input);
  const addr = env.DIGEST_EMAIL_FROM || DEFAULT_FROM;
  const from = `${FROM_NAME} <${addr}>`;

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "digest",
      event: "email-no-binding",
      message: `AUTH_EMAIL binding absent; digest not sent to ${input.to}`,
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "no_binding" };
  }

  try {
    await env.AUTH_EMAIL.send({
      to: input.to,
      from,
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    logEvent("info", {
      component: "digest",
      event: "email-sent",
      message: `Sent ${input.cadence} digest to ${input.to}`,
      count: input.releases.length,
      environment: env.ENVIRONMENT,
    });
    return { sent: true };
  } catch (err) {
    logEvent("error", {
      component: "digest",
      event: "email-send-failed",
      message: `Failed to send digest to ${input.to}`,
      error: err instanceof Error ? err.message : String(err),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "error" };
  }
}
