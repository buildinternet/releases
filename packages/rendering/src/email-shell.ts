/**
 * The Releases transactional email shell.
 *
 * One renderer for every message the platform sends — account mail, reader
 * digests, and operator alerts. Callers describe a message as blocks and get
 * back a matched pair of bodies: table-based HTML with inline styles, and the
 * plain-text alternative saying the same thing in the same order.
 *
 * Why a shell at all: before this, six senders each hand-rolled their own
 * markup (or sent text only), so nothing shared a mark, a palette, or a footer,
 * and half the alerts had no HTML part. The design is an extension of the app's
 * own tokens — the warm stone family from `@releases/design-system`, and the
 * azure from the third bar of the app icon (`oklch(0.60 0.18 252)`, flattened to
 * hex here because email clients don't parse `oklch()`).
 *
 * Email constraints that shape the code, so nobody "fixes" them later:
 *   - Styles are inline. Gmail strips `<style>` blocks in some contexts and
 *     `<link>` always; there is no cascade to rely on.
 *   - Layout is `<table>`, not flex/grid. Outlook's Word renderer supports
 *     neither.
 *   - No web fonts, and no remote images in the chrome. The wordmark is
 *     monospaced text and the mark is built from background-colored cells, so
 *     the identity survives the (very common) image-blocking default with
 *     nothing to load. Content images (an org avatar) are allowed and degrade
 *     to the text beside them.
 *   - Light palette only. Dark-mode email is client-specific and mostly
 *     un-testable; `color-scheme: light` asks clients not to auto-invert.
 */

import { inlineMarkdownToHtml, stripMarkdown } from "./strip-markdown.js";

/* ── Palette ───────────────────────────────────────────────────────────────
   Hex mirrors of the `.org-surface` token set in
   packages/design-system/src/tokens.css. Keep the two in step. */
const C = {
  page: "#f4f3f1",
  surface: "#ffffff",
  surface2: "#f7f6f4",
  ink: "#1c1917",
  ink2: "#57534e",
  ink3: "#8b857f",
  ink4: "#a8a29e",
  line: "#ededeb",
  line2: "#e0ddd9",
  accent: "#0081e7",
  accentInk: "#0068cb",
  warn: "#b4691f",
  crit: "#b4381f",
  good: "#1b9247",
} as const;

// Font stacks are quoted with APOSTROPHES, not double quotes: every style here
// lives inside a `style="…"` attribute, and a double quote in the value ends the
// attribute early — silently unstyling the rest of the element.
const SANS = `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'JetBrains Mono',Menlo,Consolas,monospace`;

/** The brand line in every footer. Says what Releases is to a first-time recipient. */
const BRAND_NAME = "Open source release notes registry";
const BRAND_URL = "https://releases.sh";
const BRAND_LINE = `${BRAND_NAME} · releases.sh`;

/** Severity of the top rule + lane label: the lane reads before the subject does. */
export type EmailTone = "accent" | "warn" | "crit";

const TONE_COLOR: Record<EmailTone, string> = {
  accent: C.accent,
  warn: C.warn,
  crit: C.crit,
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `href` values are attribute-escaped but otherwise passed through — a query
 *  string's `&` must stay live or a signed URL corrupts. */
function href(url: string): string {
  return url.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/* ── Subject helpers ────────────────────────────────────────────────────── */

/**
 * "Cloudflare, Anthropic +2 more" — name the affected things in the subject.
 *
 * A subject that says "1 source failed" or "3 messages" forces the reader to
 * open the message to learn what it is about. Naming the first one or two and
 * counting the rest fits the ~45 characters an inbox list actually shows and
 * answers "does this concern me?" without a click. Blank names are dropped and
 * duplicates collapse, so a burst of failures on one org reads as that org
 * rather than as "Acme, Acme +3 more".
 */
export function subjectNames(names: Array<string | null | undefined>, max = 2): string {
  const unique = [...new Set(names.map((n) => n?.trim()).filter((n): n is string => !!n))];
  if (unique.length === 0) return "";
  const shown = unique.slice(0, max).join(", ");
  const rest = unique.length - Math.min(unique.length, max);
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/* ── Blocks ─────────────────────────────────────────────────────────────── */

export type EmailDataRow = {
  label: string;
  value: string;
  /** Tints the value: an error reads red, a healthy count reads green. */
  kind?: "err" | "ok";
};

export type EmailPost = {
  title: string;
  url: string;
  /** Markdown one-liner; rendered to inline HTML and to prose. */
  summary?: string | null;
  meta?: string | null;
  /** importance >= 4 — leads its group and carries the signal marker. */
  highSignal?: boolean;
  /**
   * A title that carries no signal on its own ("Bug fixes and small
   * improvements"). Rendered as quiet ink rather than an accent link so it can't
   * read as loudly as a real feature post.
   */
  muted?: boolean;
};

export type EmailRollup = {
  product: string;
  version: string;
  /** Total releases in the burst; shown as "· N releases" when > 1. */
  count?: number;
  blurb?: string | null;
  /** "and 4 more" — the collapsed tail of a version burst. */
  more?: string | null;
  /** The product page — where the collapsed tail lives. */
  url?: string;
  /** The representative release itself, behind the version pill. */
  versionUrl?: string;
};

export type EmailBlock =
  /** Body copy. `text` is markdown; both parts render it, neither shows syntax. */
  | { t: "p"; text: string }
  /** Secondary copy — expiry notices, "ignore this if…" caveats. */
  | { t: "fine"; text: string }
  /** Monospace section label above a group. */
  | { t: "kicker"; text: string }
  /**
   * The primary action. Always paired with the URL in readable text beneath it:
   * a button is an anchor, and an anchor is unusable to anyone whose client
   * blocks it, who is reading the plain-text part, or who wants to move the
   * link to another device.
   */
  | { t: "button"; label: string; url: string }
  /** Aligned key/value pairs — operator mail is instrumentation. */
  | { t: "data"; rows: EmailDataRow[] }
  /** One subject (a source, a query, a subscription) with its metrics. */
  | { t: "entity"; coord: string; metrics: string; url?: string; sev?: "warn" | "crit" }
  /** A digest's per-org group. */
  | {
      t: "orgGroup";
      name: string;
      url?: string;
      /**
       * Org avatar. The one remote image the shell allows: it is content, not
       * chrome, and a blocked image degrades to the org name sitting beside it.
       */
      avatarUrl?: string | null;
      posts: EmailPost[];
      rollups?: EmailRollup[];
    };

export type EmailFooterLink = { label: string; href: string };

export type EmailFooter = {
  /** One sentence: why this landed in their inbox. Required, every message. */
  reason: string;
  /** Where to act on that — preferences, unsubscribe, admin. */
  links?: EmailFooterLink[];
};

/**
 * Gmail annotations (https://developers.google.com/workspace/gmail/markup).
 *
 * `view` is a Go-To Action: a button beside the subject in the inbox list that
 * opens `url`. `confirm` is a One-Click Action: Gmail POSTs to `postUrl`
 * directly from the inbox and the reader never opens the message.
 *
 * Both are inert until the sending domain is registered with Google and passes
 * DKIM/SPF/DMARC — the markup is harmless everywhere else, and Gmail ignores it
 * for unregistered senders. A `confirm` handler MUST accept an unauthenticated
 * POST carrying its own token, and must be idempotent: Google may retry.
 */
export type EmailAction =
  | { kind: "view"; name: string; url: string }
  | { kind: "confirm"; name: string; postUrl: string };

export type EmailDoc = {
  /** Right side of the masthead, e.g. "Account · Verify". */
  lane: string;
  tone?: EmailTone;
  title: string;
  /** Monospace line under the title — dates, run ids, counts. */
  subtitle?: string;
  /**
   * The line clients preview next to the subject. Without one they scrape the
   * first body text, which is usually the title again.
   */
  preheader?: string;
  blocks: EmailBlock[];
  footer: EmailFooter;
  action?: EmailAction;
};

/* ── HTML ──────────────────────────────────────────────────────────────── */

const codeStyle = `font-family:${MONO};font-size:0.9em;background:${C.surface2};border:1px solid ${C.line};border-radius:2px;padding:0 3px;`;
const linkStyle = `color:${C.accentInk};`;

function md(text: string): string {
  return inlineMarkdownToHtml(text, { code: codeStyle, link: linkStyle });
}

function blockHtml(b: EmailBlock): string {
  switch (b.t) {
    case "p":
      return `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.ink2};">${md(b.text)}</p>`;

    case "fine":
      return `<p style="margin:0 0 16px;font-family:${SANS};font-size:13px;line-height:1.55;color:${C.ink3};">${md(b.text)}</p>`;

    case "kicker":
      return `<p style="margin:20px 0 10px;padding-top:14px;border-top:1px solid ${C.line};font-family:${MONO};font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:${C.ink3};">${escapeHtml(b.text)}</p>`;

    case "button": {
      const u = href(b.url);
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;">` +
        `<tr><td style="background:${C.accent};border-radius:3px;">` +
        `<a href="${u}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(b.label)}</a>` +
        `</td></tr></table>` +
        // The copy-pasteable twin. Not a fallback nicety — for a reader on a
        // client that strips the button, or moving the link to another device,
        // this IS the action.
        `<p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.ink4};">` +
        `Or paste this link into your browser:<br>` +
        `<a href="${u}" style="font-family:${MONO};font-size:11.5px;color:${C.ink3};word-break:break-all;">${escapeHtml(b.url)}</a>` +
        `</p>`
      );
    }

    case "data": {
      const rows = b.rows
        .map((r) => {
          const color = r.kind === "err" ? C.crit : r.kind === "ok" ? C.good : C.ink2;
          return (
            `<tr>` +
            `<td style="padding:2px 14px 2px 0;font-family:${MONO};font-size:12px;color:${C.ink4};white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>` +
            `<td style="padding:2px 0;font-family:${MONO};font-size:12px;color:${color};word-break:break-word;">${escapeHtml(r.value)}</td>` +
            `</tr>`
          );
        })
        .join("");
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
        `style="margin:0 0 16px;background:${C.surface2};border:1px solid ${C.line};border-radius:3px;">` +
        `<tr><td style="padding:12px 14px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>` +
        `</table>`
      );
    }

    case "entity": {
      const edge = b.sev === "crit" ? C.crit : b.sev === "warn" ? C.warn : C.line2;
      const coord = b.url
        ? `<a href="${href(b.url)}" style="color:${C.ink};text-decoration:none;">${escapeHtml(b.coord)}</a>`
        : escapeHtml(b.coord);
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 12px;">` +
        `<tr><td width="2" style="width:2px;background:${edge};font-size:0;line-height:0;">&nbsp;</td>` +
        `<td style="padding:0 0 0 12px;">` +
        `<div style="font-family:${SANS};font-size:14.5px;font-weight:600;color:${C.ink};">${coord}</div>` +
        `<div style="font-family:${MONO};font-size:11.5px;color:${C.ink3};padding-top:3px;">${escapeHtml(b.metrics)}</div>` +
        `</td></tr></table>`
      );
    }

    case "orgGroup": {
      const name = b.url
        ? `<a href="${href(b.url)}" style="color:${C.ink};text-decoration:none;">${escapeHtml(b.name)}</a>`
        : escapeHtml(b.name);
      const avatar = b.avatarUrl
        ? `<img src="${href(b.avatarUrl)}" width="20" height="20" alt="" style="width:20px;height:20px;border-radius:5px;vertical-align:middle;margin-right:8px;">`
        : "";
      const head = `<p style="margin:0 0 10px;font-family:${SANS};font-size:16px;font-weight:600;color:${C.ink};">${avatar}${name}</p>`;

      const posts = b.posts
        .map((p) => {
          // The web marks importance >= 4 with a flame. Emoji and icon fonts are
          // unreliable in mail, so it becomes a filled azure square drawn as a
          // bordered cell — visible everywhere, including with images off.
          const mark = p.highSignal
            ? `<span style="display:inline-block;width:6px;height:6px;background:${C.accent};border-radius:1px;margin-right:7px;vertical-align:middle;"></span>`
            : "";
          const summary = p.summary
            ? `<div style="font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.ink2};padding-top:2px;">${md(p.summary)}</div>`
            : "";
          const meta = p.meta
            ? `<div style="font-family:${MONO};font-size:11px;color:${C.ink4};padding-top:3px;">${escapeHtml(p.meta)}</div>`
            : "";
          const titleStyle = p.muted
            ? `color:${C.ink2};font-weight:500;text-decoration:none;`
            : `color:${C.accentInk};font-weight:600;text-decoration:none;`;
          return (
            `<div style="margin:0 0 12px;">` +
            `<div style="font-family:${SANS};font-size:15px;font-weight:600;line-height:1.4;">${mark}` +
            `<a href="${href(p.url)}" style="${titleStyle}">${md(p.title)}</a></div>` +
            summary +
            meta +
            `</div>`
          );
        })
        .join("");

      const rollups = (b.rollups ?? [])
        .map((r) => {
          const label = r.url
            ? `<a href="${href(r.url)}" style="color:${C.ink};text-decoration:none;">${escapeHtml(r.product)}</a>`
            : escapeHtml(r.product);
          const blurb = r.blurb
            ? `<div style="font-family:${SANS};font-size:12.5px;color:${C.ink3};padding-top:3px;">${md(r.blurb)}</div>`
            : "";
          const more = r.more
            ? `<div style="font-family:${MONO};font-size:11px;color:${C.ink4};padding-top:3px;">${escapeHtml(r.more)}</div>`
            : "";
          // The pill links to the representative release; the product name links
          // to the page holding the rest of the burst.
          const version = r.versionUrl
            ? `<a href="${href(r.versionUrl)}" style="color:${C.ink2};text-decoration:none;">${escapeHtml(r.version)}</a>`
            : escapeHtml(r.version);
          const count =
            r.count && r.count > 1
              ? `<span style="font-family:${SANS};font-size:12.5px;color:${C.ink4};margin-left:6px;">&middot; ${r.count} releases</span>`
              : "";
          return (
            `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ` +
            `style="margin:0 0 8px;background:${C.surface2};border:1px solid ${C.line};border-radius:3px;">` +
            `<tr><td style="padding:9px 12px;">` +
            `<span style="font-family:${SANS};font-size:13.5px;font-weight:600;color:${C.ink};">${label}</span>${count}` +
            `<span style="font-family:${MONO};font-size:11px;color:${C.ink2};border:1px solid ${C.line2};border-radius:2px;padding:1px 5px;background:${C.surface};margin-left:8px;">${version}</span>` +
            blurb +
            more +
            `</td></tr></table>`
          );
        })
        .join("");

      return `<div style="margin:0 0 22px;">${head}${posts}${rollups}</div>`;
    }
  }
}

/** The mark: three bars on a dark rounded square, drawn as table cells so it
 *  needs no image and survives image-blocking. */
function markHtml(): string {
  const bar = (w: number, color: string, top: number): string =>
    `<tr><td style="height:${top}px;font-size:0;line-height:0;">&nbsp;</td></tr>` +
    `<tr><td style="font-size:0;line-height:0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="${w}" height="3" style="width:${w}px;height:3px;background:${color};border-radius:1px;font-size:0;line-height:0;">&nbsp;</td>` +
    `</tr></table></td></tr>`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="22" height="22" ` +
    `style="width:22px;height:22px;background:${C.ink};border-radius:5px;">` +
    `<tr><td style="padding:5px 5px 6px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0">` +
    bar(12, "#f5f5f4", 0) +
    bar(9, "#c9c5c1", 2) +
    bar(14, C.accent, 2) +
    `</table>` +
    `</td></tr></table>`
  );
}

function actionMarkup(action: EmailAction, description: string): string {
  const ld =
    action.kind === "view"
      ? {
          "@context": "http://schema.org",
          "@type": "EmailMessage",
          potentialAction: { "@type": "ViewAction", name: action.name, target: action.url },
          description,
        }
      : {
          "@context": "http://schema.org",
          "@type": "EmailMessage",
          potentialAction: {
            "@type": "ConfirmAction",
            name: action.name,
            handler: {
              "@type": "HttpActionHandler",
              url: action.postUrl,
              method: "http://schema.org/HttpRequestMethod/POST",
            },
          },
          description,
        };
  // `</script>` inside a JSON string would close the tag early; nothing else in
  // a URL or a name can break out.
  return `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`;
}

function footerHtml(footer: EmailFooter): string {
  const links = (footer.links ?? [])
    .map(
      (l) =>
        `<a href="${href(l.href)}" style="color:${C.ink3};text-decoration:underline;">${escapeHtml(l.label)}</a>`,
    )
    .join(" &middot; ");
  return (
    `<p style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.ink3};">${escapeHtml(footer.reason)}</p>` +
    (links
      ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:1.5;">${links}</p>`
      : "") +
    `<p style="margin:0;font-family:${MONO};font-size:10.5px;letter-spacing:0.04em;color:${C.ink4};">` +
    `<a href="${BRAND_URL}" style="color:${C.ink4};text-decoration:none;">${escapeHtml(BRAND_LINE)}</a></p>`
  );
}

/** Trailing invisible characters keep the client from padding the preview line
 *  with body copy that follows it. */
const PREHEADER_PAD = "&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;".repeat(15);

function renderHtml(doc: EmailDoc): string {
  const tone = TONE_COLOR[doc.tone ?? "accent"];
  const body = doc.blocks.map(blockHtml).join("");
  const preheader = doc.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${escapeHtml(doc.preheader)}${PREHEADER_PAD}</div>`
    : "";
  const subtitle = doc.subtitle
    ? `<p style="margin:6px 0 0;font-family:${MONO};font-size:12px;color:${C.ink3};">${escapeHtml(doc.subtitle)}</p>`
    : "";

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<meta name="supported-color-schemes" content="light">` +
    `<title>${escapeHtml(doc.title)}</title>` +
    (doc.action ? actionMarkup(doc.action, doc.preheader ?? doc.title) : "") +
    `</head>` +
    `<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">` +
    preheader +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.page};">` +
    `<tr><td align="center" style="padding:24px 12px 32px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" ` +
    `style="width:100%;max-width:600px;background:${C.surface};border:1px solid ${C.line};border-radius:4px;">` +
    // The logo's bottom bar, extended across the message and carrying severity.
    `<tr><td style="height:3px;font-size:0;line-height:0;background:${tone};">&nbsp;</td></tr>` +
    `<tr><td style="padding:16px 24px;border-bottom:1px solid ${C.line};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>` +
    `<td align="left" style="vertical-align:middle;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="vertical-align:middle;">${markHtml()}</td>` +
    `<td style="padding-left:9px;vertical-align:middle;font-family:${MONO};font-size:12.5px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${C.ink};">Releases</td>` +
    `</tr></table></td>` +
    `<td align="right" style="vertical-align:middle;font-family:${MONO};font-size:10px;letter-spacing:0.09em;text-transform:uppercase;color:${doc.tone && doc.tone !== "accent" ? tone : C.ink3};">${escapeHtml(doc.lane)}</td>` +
    `</tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:26px 24px 8px;">` +
    `<h1 style="margin:0;font-family:${SANS};font-size:21px;line-height:1.3;font-weight:600;color:${C.ink};">${escapeHtml(doc.title)}</h1>` +
    subtitle +
    `</td></tr>` +
    `<tr><td style="padding:18px 24px 6px;">${body}</td></tr>` +
    `<tr><td style="padding:16px 24px 20px;border-top:1px solid ${C.line};background:${C.surface2};">${footerHtml(doc.footer)}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

/* ── Plain text ─────────────────────────────────────────────────────────── */

function blockText(b: EmailBlock): string[] {
  switch (b.t) {
    case "p":
      return [stripMarkdown(b.text), ""];
    case "fine":
      return [stripMarkdown(b.text), ""];
    case "kicker":
      return [b.text.toUpperCase(), ""];
    case "button":
      return [`${b.label}: ${b.url}`, ""];
    case "data": {
      const width = Math.max(...b.rows.map((r) => r.label.length)) + 2;
      return [...b.rows.map((r) => `  ${`${r.label}:`.padEnd(width)}${r.value}`), ""];
    }
    case "entity":
      return [b.coord, `    ${b.metrics}`, ...(b.url ? [`    ${b.url}`] : []), ""];
    case "orgGroup": {
      const lines = [b.name.toUpperCase()];
      for (const p of b.posts) {
        lines.push(`  ${p.highSignal ? "* " : "- "}${stripMarkdown(p.title)}`);
        if (p.summary) lines.push(`      ${stripMarkdown(p.summary)}`);
        lines.push(`      ${p.url}`);
      }
      for (const r of b.rollups ?? []) {
        const count = r.count && r.count > 1 ? ` · ${r.count} releases` : "";
        lines.push(`  - ${r.product}${count}  ${r.version}${r.more ? ` (${r.more})` : ""}`);
        if (r.blurb) lines.push(`      ${stripMarkdown(r.blurb)}`);
        if (r.versionUrl) lines.push(`      ${r.versionUrl}`);
        if (r.url && r.url !== r.versionUrl) lines.push(`      ${r.url}`);
      }
      lines.push("");
      return lines;
    }
  }
}

function renderText(doc: EmailDoc): string {
  const lines: string[] = [doc.title];
  if (doc.subtitle) lines.push(doc.subtitle);
  lines.push("");
  for (const b of doc.blocks) lines.push(...blockText(b));
  lines.push("—", doc.footer.reason);
  for (const l of doc.footer.links ?? []) lines.push(`${l.label}: ${l.href}`);
  lines.push("", `${BRAND_NAME} · ${BRAND_URL}`);
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/**
 * Render a message into its HTML and plain-text parts. Both are always produced
 * — a text/plain alternative is what keeps the mail out of spam filters and
 * readable in a terminal client, and it is the only body some operators ever see.
 */
export function renderEmail(doc: EmailDoc): { html: string; text: string } {
  return { html: renderHtml(doc), text: renderText(doc) };
}

export { BRAND_LINE, C as EMAIL_COLORS };
