import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import { resolveSourceKind } from "@buildinternet/releases-core/kinds";
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
  /**
   * The run-start instant the digest covers up to (ISO-8601) — drives the dated
   * qualifier in the subject/title. Daily labels with this date; weekly labels
   * "week of" the start of the 7-day window ending here. Omitted ⇒ no date shown
   * (backward compatible).
   */
  referenceDate?: string;
}

export type DigestEmailInput = DigestEmailContent & { to: string };

const DEFAULT_FROM = "digests@releases.sh";
const FROM_NAME = "Releases.sh";

// Shared inline styles (email-safe: inline only, system font stack).
const ACCENT = "#1a56db";
const INK = "#111827";
const INK_SOFT = "#374151";
const BODY = "#4b5563";
const MUTED = "#6b7280";
const FAINT = "#9ca3af";

function bestTitle(r: ReleaseLatestItem): string {
  return r.titleShort || r.titleGenerated || r.title || r.version || "Update";
}

/** Lowercased, whitespace-collapsed, trailing-punctuation-stripped — for equality
 *  checks between a title and its summary and for boilerplate matching. */
function norm(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
}

// Titles that carry no signal on their own — rendered muted rather than as a
// prominent accent link, so a "bug fixes" note doesn't read as loudly as a real
// feature post.
const LOW_SIGNAL_TITLE =
  /^(bug fixes|minor (bug )?fixes|various (bug )?fixes|bug fixes and (small )?(improvements|performance improvements)|(small|general|stability|performance) improvements)$/;

function isLowSignalPost(r: ReleaseLatestItem): boolean {
  return LOW_SIGNAL_TITLE.test(norm(bestTitle(r)));
}

/** A post's summary, or null when it's absent or merely restates the title (e.g.
 *  a "Bug fixes and small improvements" body under the same headline) — dropping
 *  the duplicate keeps the post to one line instead of echoing itself. */
function postSummary(r: ReleaseLatestItem): string | null {
  const s = (r.summary ?? "").trim();
  if (!s) return null;
  if (norm(s) === norm(bestTitle(r))) return null;
  return s;
}

// Subject/title dates render in Eastern time to match the project's ET day
// convention (etDayKey) — a digest "for Jun 24" reads as the US-Eastern day,
// not a UTC boundary that flips hours earlier.
const DIGEST_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The dated qualifier for the subject/title: the run date for a daily digest
 * (`Jun 24, 2026`), or "week of" the start of the covered 7-day window for a
 * weekly one (`week of Jun 17, 2026`). The weekly window is anchored to the run
 * date minus 7 days so the label tracks the cadence regardless of the recipient's
 * last-digest watermark.
 */
function digestDateLabel(cadence: "daily" | "weekly", referenceDate: string): string {
  const end = new Date(referenceDate);
  if (cadence === "weekly") {
    return `week of ${DIGEST_DATE_FMT.format(new Date(end.getTime() - WEEK_MS))}`;
  }
  return DIGEST_DATE_FMT.format(end);
}

function releaseUrl(baseUrl: string, r: ReleaseLatestItem): string {
  // Prefer the slugged canonical (`webUrl`, populated when the row is mapped
  // with a webBase); fall back to the bare-ID path, which 308s to canonical.
  return r.webUrl ?? `${baseUrl}/release/${r.id}`;
}

// A release folds into a compact per-product rollup — instead of a hero post —
// when it's a GitHub version-tag drop OR its resolved kind is "sdk". Both are the
// high-frequency, low-signal rows a reader wants compressed to a line, not the
// content posts that earn a title + summary. Using the `kind` signal (surfaced on
// /releases/latest, #2051) means an SDK published via a feed collapses too, not
// just GitHub tags — the "always prioritize non-SDK over SDK" intent.
function isRollupItem(r: ReleaseLatestItem): boolean {
  return r.source.type === "github" || resolveSourceKind(r.source, r.product ?? null) === "sdk";
}

function partitionOrgItems(items: ReleaseLatestItem[]): {
  posts: ReleaseLatestItem[];
  rollups: ReleaseLatestItem[];
} {
  const posts: ReleaseLatestItem[] = [];
  const rollups: ReleaseLatestItem[] = [];
  for (const r of items) (isRollupItem(r) ? rollups : posts).push(r);
  return { posts, rollups };
}

/**
 * Collapse a day's rollup releases into per-product buckets, keyed on the
 * server-resolved group identity (`groupSlug`/`groupName` = product ?? source,
 * #1234) so it matches the web timeline. Preserves input (published-desc) order.
 */
function groupByProduct(
  rollups: ReleaseLatestItem[],
): Array<{ label: string; items: ReleaseLatestItem[] }> {
  const groups = new Map<string, { label: string; items: ReleaseLatestItem[] }>();
  for (const r of rollups) {
    const key = r.groupSlug ?? r.product?.slug ?? r.source.slug;
    let g = groups.get(key);
    if (!g) {
      g = { label: r.groupName ?? r.product?.name ?? r.source.name, items: [] };
      groups.set(key, g);
    }
    g.items.push(r);
  }
  return [...groups.values()];
}

function versionLabel(r: ReleaseLatestItem): string {
  return r.version || r.title || "—";
}

/** Trim a blurb to a single, length-capped line. */
function clampLine(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  const LIMIT = 130;
  return one.length > LIMIT ? `${one.slice(0, LIMIT - 1).trimEnd()}…` : one;
}

/**
 * A one-line blurb for a rollup release, or null when it carries no real notes.
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
 * Compress a per-product rollup to a single representative release: its version is
 * the only pill shown, its notes become the "Latest —" line, and every other
 * release folds into "and N more". The representative is the most recent release
 * that carries real notes (so the pill and the blurb describe the same release),
 * falling back to the newest when the whole burst is note-less. Enumerating every
 * version was the noise the redesign set out to kill — five tags on one SDK now
 * read as one version + "and 4 more", not five near-identical rows.
 */
function rollupView(items: ReleaseLatestItem[]): {
  rep: ReleaseLatestItem;
  blurb: string | null;
  hiddenCount: number;
} {
  for (const r of items) {
    const b = tagBlurb(r);
    if (b) return { rep: r, blurb: b, hiddenCount: items.length - 1 };
  }
  return { rep: items[0], blurb: null, hiddenCount: items.length - 1 };
}

/** The product (or source) page on the web app — where "and N more" sends the reader. */
function productPageUrl(baseUrl: string, r: ReleaseLatestItem): string {
  const org = r.source.orgSlug;
  const slug = r.groupSlug ?? r.product?.slug ?? r.source.slug;
  return org ? `${baseUrl}/${org}/${slug}` : releaseUrl(baseUrl, r);
}

/** The org avatar to render beside its heading: the explicit stored avatar, else
 *  the GitHub handle's `.png`, else none (heading renders text-only). */
function orgAvatarSrc(source: ReleaseLatestItem["source"]): string | null {
  if (source.orgAvatarUrl) return source.orgAvatarUrl;
  if (source.orgGithubHandle) return `https://github.com/${source.orgGithubHandle}.png?size=48`;
  return null;
}

/** Group releases by owning org slug, preserving input (published-desc) order. */
function groupByOrg(releases: ReleaseLatestItem[]): Array<{
  orgSlug: string | null;
  orgName: string;
  avatar: string | null;
  items: ReleaseLatestItem[];
}> {
  const groups = new Map<
    string,
    { orgSlug: string | null; orgName: string; avatar: string | null; items: ReleaseLatestItem[] }
  >();
  for (const r of releases) {
    const key = r.source.orgSlug ?? r.source.name;
    let g = groups.get(key);
    if (!g) {
      // Heading is the org's display name ("Cloudflare"), not a source name
      // ("Cloudflare workerd"). Fall back to the source name only when the
      // source has no owning org (orgName/orgSlug null).
      g = {
        orgSlug: r.source.orgSlug,
        orgName: r.source.orgName ?? r.source.name,
        avatar: orgAvatarSrc(r.source),
        items: [],
      };
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
  const { releases, baseUrl, manageUrl, unsubscribeUrl, cadence, referenceDate } = content;
  const n = releases.length;
  const updates = `${n} update${n === 1 ? "" : "s"}`;
  const dateLabel = referenceDate ? digestDateLabel(cadence, referenceDate) : "";
  const subject = `Your ${cadence} Releases digest — ${dateLabel ? `${dateLabel} · ` : ""}${updates}`;
  const groups = groupByOrg(releases);
  const orgSpan = groups.length > 1 ? ` across ${groups.length} orgs` : "";

  // ---- plain text ----
  const textLines: string[] = [subject, ""];
  for (const g of groups) {
    textLines.push(g.orgName.toUpperCase());
    const { posts, rollups } = partitionOrgItems(g.items);
    for (const r of posts) {
      const prod = r.product ? ` (${r.product.name})` : "";
      textLines.push(`  • ${bestTitle(r)}${prod}`);
      const summary = postSummary(r);
      if (summary) textLines.push(`    ${summary}`);
      textLines.push(`    ${releaseUrl(baseUrl, r)}`);
    }
    // Per-product rollup: one line — product, newest version, "and N more", plus a
    // single representative note. Deliberately not an enumerated version list.
    for (const tg of groupByProduct(rollups)) {
      const { rep, blurb, hiddenCount } = rollupView(tg.items);
      const count = tg.items.length;
      textLines.push(`  ${tg.label}${count > 1 ? ` · ${count} releases` : ""}`);
      const more = hiddenCount > 0 ? ` (and ${hiddenCount} more)` : "";
      textLines.push(`    ${versionLabel(rep)}${more}`);
      if (blurb) textLines.push(`    Latest — ${blurb}`);
      textLines.push(
        `    ${hiddenCount > 0 ? productPageUrl(baseUrl, rep) : releaseUrl(baseUrl, rep)}`,
      );
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

  // ---- HTML ----
  // Masthead replaces the old H1-that-just-repeated-the-subject: a compact wordmark
  // + a one-line count. The inbox already shows the subject sentence.
  const htmlParts: string[] = [
    `<div style="border-bottom:2px solid ${INK};padding-bottom:9px;margin:0 0 4px">` +
      `<span style="font:700 12px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:${INK}">Releases</span>` +
      `<span style="font:13px system-ui,sans-serif;color:${MUTED}">&nbsp;&nbsp;${escapeHtml(dateLabel ? `${dateLabel} · ` : "")}${updates}${orgSpan}</span>` +
      `</div>`,
  ];
  for (const g of groups) {
    const avatar = g.avatar
      ? `<img src="${escapeHtml(g.avatar)}" width="20" height="20" alt="" style="border-radius:5px;vertical-align:middle;margin-right:8px">`
      : "";
    const nameHtml = g.orgSlug
      ? `<a href="${escapeHtml(`${baseUrl}/${g.orgSlug}`)}" style="color:${INK};text-decoration:none">${escapeHtml(g.orgName)}</a>`
      : escapeHtml(g.orgName);
    htmlParts.push(
      `<h2 style="font:600 15px system-ui,sans-serif;margin:20px 0 8px">${avatar}${nameHtml}</h2>`,
    );
    const { posts, rollups } = partitionOrgItems(g.items);
    for (const r of posts) {
      const prod = r.product
        ? ` <span style="color:${FAINT}">${escapeHtml(r.product.name)}</span>`
        : "";
      const summary = postSummary(r);
      const low = isLowSignalPost(r);
      const titleStyle = low
        ? `font-weight:500;color:${MUTED};text-decoration:none`
        : `font-weight:600;color:${ACCENT};text-decoration:none`;
      htmlParts.push(
        `<p style="margin:8px 0;font:14px system-ui,sans-serif">` +
          `<a href="${escapeHtml(releaseUrl(baseUrl, r))}" style="${titleStyle}">${escapeHtml(bestTitle(r))}</a>${prod}` +
          (summary ? `<br><span style="color:${BODY}">${escapeHtml(summary)}</span>` : "") +
          `</p>`,
      );
    }
    // Per-product rollup: product + newest version pill + "and N more" on one line,
    // a single "Latest —" note below. Compresses a version burst to two lines.
    for (const tg of groupByProduct(rollups)) {
      const { rep, blurb, hiddenCount } = rollupView(tg.items);
      const count = tg.items.length;
      const pill = `<a href="${escapeHtml(releaseUrl(baseUrl, rep))}" style="display:inline-block;font:12px ui-monospace,monospace;color:#475569;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 6px;text-decoration:none">${escapeHtml(versionLabel(rep))}</a>`;
      const more =
        hiddenCount > 0
          ? ` <a href="${escapeHtml(productPageUrl(baseUrl, rep))}" style="font:13px system-ui,sans-serif;color:${ACCENT};text-decoration:none">and ${hiddenCount} more →</a>`
          : "";
      const countLabel =
        count > 1 ? ` <span style="color:${FAINT};font-weight:400">· ${count} releases</span>` : "";
      const blurbHtml = blurb
        ? `<div style="font:13px system-ui,sans-serif;color:${MUTED};margin-top:2px">Latest — ${escapeHtml(blurb)}</div>`
        : "";
      htmlParts.push(
        `<div style="margin:10px 0">` +
          `<div style="font:14px system-ui,sans-serif;margin-bottom:1px">` +
          `<span style="font-weight:600;color:${INK_SOFT}">${escapeHtml(tg.label)}</span>${countLabel}&nbsp;&nbsp;${pill}${more}` +
          `</div>` +
          blurbHtml +
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
