import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import { logEvent } from "@releases/lib/log-event";
import { escapeHtml } from "./html-escape.js";
import { appendHtmlFooter, appendTextFooter } from "./email-layout.js";
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

/** How many substantive tags a rollup surfaces before collapsing to "+N more". */
const ROLLUP_VISIBLE = 3;

/** Trim a blurb to a single, length-capped line. */
function clampLine(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  const LIMIT = 130;
  return one.length > LIMIT ? `${one.slice(0, LIMIT - 1).trimEnd()}…` : one;
}

/**
 * A one-line blurb for a tag release, or null when it carries no real notes.
 * The generated `titleShort` is the canonical one-liner and — crucially — is
 * precisely null for the low-information drops (dependency bumps, auto-generated
 * "Full Changelog" releases), so its presence doubles as the substance signal.
 * Falls back to the body summary only when that isn't itself changelog boilerplate.
 */
function tagBlurb(r: ReleaseLatestItem): string | null {
  const short = (r.titleShort ?? "").trim();
  if (short) return clampLine(short);
  const summary = (r.summary ?? "").trim();
  if (!summary) return null;
  const bare = summary.replace(/[*`#]/g, "").trim();
  if (/^full changelog\b/i.test(bare)) return null;
  if (/^(patch|minor|major) changes\b/i.test(bare)) return null;
  return clampLine(summary.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, ""));
}

/**
 * Pick which tags a per-product rollup renders: the newest few that carry a real
 * blurb, with everything else (overflow + low-information drops) folded into a
 * hidden count. If nothing in the group has a blurb, still surface the newest one
 * (version only) so the rollup is never an empty header.
 */
function splitRollup(items: ReleaseLatestItem[]): {
  shown: Array<{ r: ReleaseLatestItem; blurb: string }>;
  hiddenCount: number;
} {
  const withBlurb: Array<{ r: ReleaseLatestItem; blurb: string }> = [];
  for (const r of items) {
    const b = tagBlurb(r);
    if (b) withBlurb.push({ r, blurb: b });
  }
  const shown = withBlurb.slice(0, ROLLUP_VISIBLE);
  if (shown.length === 0 && items.length > 0) shown.push({ r: items[0], blurb: "" });
  return { shown, hiddenCount: items.length - shown.length };
}

/** The product (or source) page on the web app — where "+N more" sends the reader. */
function productPageUrl(baseUrl: string, r: ReleaseLatestItem): string {
  const org = r.source.orgSlug;
  const slug = r.product?.slug ?? r.source.slug;
  return org ? `${baseUrl}/${org}/${slug}` : releaseUrl(baseUrl, r);
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
    // Version-tag rollup: one product header, then the newest few substantive
    // updates with their one-line notes, the rest folded into "+N more". Surfaces
    // real content instead of a wall of information-less version pills.
    for (const tg of groupTagsByProduct(tags)) {
      const { shown, hiddenCount } = splitRollup(tg.items);
      const count = tg.items.length;
      textLines.push(`  ${tg.label}${count > 1 ? ` · ${count} updates` : ""}`);
      for (const { r, blurb } of shown) {
        textLines.push(blurb ? `    ${versionLabel(r)} — ${blurb}` : `    ${versionLabel(r)}`);
        textLines.push(`      ${releaseUrl(baseUrl, r)}`);
      }
      if (hiddenCount > 0) {
        textLines.push(`    + ${hiddenCount} more: ${productPageUrl(baseUrl, tg.items[0])}`);
      }
    }
    textLines.push("");
  }
  const digestFooter = {
    reason: `You received this ${cadence} digest because you follow releases on Releases and opted in to email updates.`,
    links: [
      { label: "Manage digest preferences", href: manageUrl },
      { label: "Unsubscribe", href: unsubscribeUrl },
    ],
  };
  const text = appendTextFooter(textLines.join("\n"), digestFooter);

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
    // Version-tag rollup: a product header, then the newest few substantive
    // updates (version pill + one-line note), the rest folded into a "+N more"
    // link to the product page — the email analogue of the timeline's commit-log
    // rollup, but carrying the notes email readers can't click to expand.
    for (const tg of groupTagsByProduct(tags)) {
      const { shown, hiddenCount } = splitRollup(tg.items);
      const count = tg.items.length;
      const rows = shown
        .map(({ r, blurb }) => {
          const pill = `<a href="${escapeHtml(releaseUrl(baseUrl, r))}" style="display:inline-block;font:12px ui-monospace,monospace;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;text-decoration:none">${escapeHtml(versionLabel(r))}</a>`;
          const note = blurb ? ` <span style="color:#444">${escapeHtml(blurb)}</span>` : "";
          return `<div style="margin:4px 0;font:14px system-ui,sans-serif">${pill}${note}</div>`;
        })
        .join("");
      const more =
        hiddenCount > 0
          ? `<div style="margin:4px 0"><a href="${escapeHtml(productPageUrl(baseUrl, tg.items[0]))}" style="font:13px system-ui,sans-serif;color:#1a56db;text-decoration:none">+ ${hiddenCount} more →</a></div>`
          : "";
      const countLabel =
        count > 1 ? ` <span style="color:#888;font-weight:400">· ${count} updates</span>` : "";
      htmlParts.push(
        `<div style="margin:10px 0">` +
          `<div style="font-weight:600;color:#444;font:14px system-ui,sans-serif;margin-bottom:2px">${escapeHtml(tg.label)}${countLabel}</div>` +
          rows +
          more +
          `</div>`,
      );
    }
  }
  const html = appendHtmlFooter(htmlParts.join(""), digestFooter);

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
