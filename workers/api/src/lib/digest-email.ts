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

// GitHub releases are version-tag drops (the "SDK-style" rows). In the web
// timelines they collapse into a compact per-product commit-log rollup instead
// of a hero card; the digest mirrors that so a burst of version bumps reads as
// one tidy line per product rather than N near-identical paragraphs. Kept as a
// local literal check (not the web `isTag` helper, which lives in a component
// the worker must not import).
function isTagRelease(r: ReleaseLatestItem): boolean {
  return r.source.type === "github";
}

function partitionOrgItems(items: ReleaseLatestItem[]): {
  posts: ReleaseLatestItem[];
  tags: ReleaseLatestItem[];
} {
  const posts: ReleaseLatestItem[] = [];
  const tags: ReleaseLatestItem[] = [];
  for (const r of items) (isTagRelease(r) ? tags : posts).push(r);
  return { posts, tags };
}

/**
 * Collapse a day's GitHub version tags into per-product buckets (product when
 * bound, else source), preserving input (published-desc) order — the email
 * analogue of `rollupTags` in the web timeline.
 */
function groupTagsByProduct(
  tags: ReleaseLatestItem[],
): Array<{ label: string; items: ReleaseLatestItem[] }> {
  const groups = new Map<string, { label: string; items: ReleaseLatestItem[] }>();
  for (const r of tags) {
    const key = r.product?.slug ?? r.source.slug;
    let g = groups.get(key);
    if (!g) {
      g = { label: r.product?.name ?? r.source.name, items: [] };
      groups.set(key, g);
    }
    g.items.push(r);
  }
  return [...groups.values()];
}

function versionLabel(r: ReleaseLatestItem): string {
  return r.version || r.title || "—";
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
    const { posts, tags } = partitionOrgItems(g.items);
    for (const r of posts) {
      const prod = r.product ? ` (${r.product.name})` : "";
      textLines.push(`  • ${bestTitle(r)}${prod}`);
      if (r.summary) textLines.push(`    ${r.summary}`);
      textLines.push(`    ${releaseUrl(baseUrl, r)}`);
    }
    // Version-tag rollup: one product header, then a line per version. Keeps a
    // string of SDK bumps compact instead of one bullet each.
    for (const tg of groupTagsByProduct(tags)) {
      textLines.push(`  ${tg.label} (${tg.items.length})`);
      for (const r of tg.items) {
        textLines.push(`    ${versionLabel(r)} — ${releaseUrl(baseUrl, r)}`);
      }
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
    const { posts, tags } = partitionOrgItems(g.items);
    for (const r of posts) {
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
    // Version-tag rollup: one line per product, versions as monospace pill links
    // — the email analogue of the timeline's commit-log rollup.
    for (const tg of groupTagsByProduct(tags)) {
      const pills = tg.items
        .map(
          (r) =>
            `<a href="${escapeHtml(releaseUrl(baseUrl, r))}" style="display:inline-block;font:12px ui-monospace,monospace;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;margin:0 4px 4px 0;text-decoration:none">${escapeHtml(versionLabel(r))}</a>`,
        )
        .join("");
      htmlParts.push(
        `<p style="margin:8px 0;font:14px system-ui,sans-serif">` +
          `<span style="font-weight:600;color:#444">${escapeHtml(tg.label)}</span> ${pills}` +
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
