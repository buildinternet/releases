/**
 * In-band per-record validation for the tool-loop extraction path.
 *
 * Runs INSIDE the `extract_releases` tool handler, before the loop treats the
 * call as terminal — bad records are bounced back to the model as an
 * actionable tool_result so it can self-correct within the same run, instead
 * of the record silently getting dropped by post-hoc validation downstream.
 * See issue #1874.
 *
 * Deliberately narrow (first slice): cheap, deterministic, in-context checks
 * only. No network probes (HEAD requests) — deferred to a follow-up. Existing
 * post-hoc validation is untouched and remains the backstop: fail-open here
 * always means "accept and let post-hoc handle it."
 */

import { getDomain } from "tldts";
import { logEvent } from "@releases/lib/log-event";
import type { ExtractedEntry } from "./types.js";

export interface RecordValidationRejection {
  /** Index of the rejected record within the `releases` array the model sent. */
  index: number;
  /** One-sentence actionable reason, meant to be read directly by the model. */
  reason: string;
}

export interface ValidateRecordsOptions {
  /** The source's canonical URL — used to derive the expected host family. */
  sourceUrl: string;
  /**
   * Clock-skew allowance for "future date" rejection, in milliseconds.
   * Defaults to 24h to tolerate timezone confusion in extracted dates.
   */
  clockSkewMs?: number;
  /**
   * How far in the past a date can plausibly be before it's treated as
   * implausible for the window being extracted. Defaults to 20 years — wide
   * enough to never reject a real historical entry, tight enough to catch
   * epoch/placeholder defaults (1970, 0001, etc.).
   */
  maxAgeYears?: number;
}

const DEFAULT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_YEARS = 20;

// ── URL sanity ───────────────────────────────────────────────────────

/**
 * Common tracking-redirect wrapper hosts. Not exhaustive — this is a cheap,
 * high-precision denylist for the most common cases (email/marketing click
 * trackers), not a general redirect-detector (that would need a network
 * probe, deferred per #1874).
 */
const TRACKING_REDIRECT_HOSTS = [
  "click.",
  "clicks.",
  "links.",
  "track.",
  "tracking.",
  "email.",
  "mail.",
  "sendgrid.net",
  "mailchimp.com",
  "list-manage.com",
  "hubspotlinks.com",
  "hs-sites.com",
  "mkto-",
  "click.email",
  "url.emailprotection",
];

/** Fragments that are anchored to the start of the hostname (a leading-label
 *  prefix like "click." or "mkto-") vs. a full-domain suffix match (a bare
 *  registrable domain like "sendgrid.net"). Distinguishing the two avoids
 *  substring false positives while still matching each fragment the way it
 *  was intended. */
function trackingFragmentMatches(labels: string[], frag: string): boolean {
  if (frag.endsWith(".") || frag.endsWith("-")) {
    // Leading-label prefix: compare against the start of the hostname,
    // label-by-label for the dotted case ("click." -> label "click"), or a
    // literal prefix match on the first label for the hyphenated case
    // ("mkto-" -> "mkto-123.example.com").
    if (frag.endsWith("-")) return (labels[0] ?? "").startsWith(frag);
    const fragLabels = frag.split(".").filter(Boolean);
    if (fragLabels.length > labels.length) return false;
    return fragLabels.every((fl, i) => labels[i] === fl);
  }
  // Full fragment (e.g. "sendgrid.net", "click.email"): must match either the
  // whole hostname or a dot-bounded suffix of it — never a mid-label substring.
  const fragLabels = frag.split(".").filter(Boolean);
  if (fragLabels.length > labels.length) return false;
  const tail = labels.slice(labels.length - fragLabels.length);
  return tail.every((l, i) => l === fragLabels[i]);
}

/** Bare index/listing paths a specific release URL should never collapse to. */
const INDEX_PATH_RE =
  /^\/?(changelog|changelog\/?|release-notes|releases|blog|news|updates)\/?(index\.html?)?$/i;

/**
 * Public-suffix-aware registrable domain (e.g. "blog.example.co.uk" ->
 * "example.co.uk"). Falls back to the naive last-two-label heuristic when
 * `tldts` can't determine one (localhost, bare IPs, single-label hosts) —
 * those aren't on a public suffix list, so there's nothing to look up.
 */
function registrableDomain(host: string): string {
  const lower = host.toLowerCase();
  const domain = getDomain(lower);
  if (domain) return domain;
  const parts = lower.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

/**
 * Matches a tracking-redirect fragment against whole hostname labels rather
 * than a raw substring, so "myemail.example.com" doesn't false-positive on
 * the "email." fragment (which is meant to match the leading label of hosts
 * like "email.vendor.com").
 */
function isTrackingRedirectHost(host: string): boolean {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  return TRACKING_REDIRECT_HOSTS.some((frag) => trackingFragmentMatches(labels, frag));
}

/**
 * Reject URLs whose host doesn't plausibly belong to the source's domain
 * family, obvious tracking-redirect wrappers, and bare index/listing pages
 * where a specific release URL is expected.
 *
 * Returns null when the URL is acceptable (including when there's no url at
 * all — omission is valid per the tool schema and handled by the mapper's
 * synthesized-anchor fallback).
 */
export function checkUrlSanity(url: string | undefined, sourceUrl: string): string | null {
  if (!url || !url.trim()) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return null; // fragment-only anchor, resolved against sourceUrl

  let parsed: URL;
  try {
    parsed = new URL(trimmed, sourceUrl);
  } catch {
    return `URL "${trimmed}" could not be parsed — use the release's canonical absolute URL.`;
  }

  let sourceHost: string;
  try {
    sourceHost = new URL(sourceUrl).hostname;
  } catch {
    sourceHost = "";
  }

  const sourceReg = sourceHost ? registrableDomain(sourceHost) : "";
  const urlReg = registrableDomain(parsed.hostname);
  const sameRegistrableDomain = Boolean(sourceReg) && sourceReg === urlReg;

  // A host on the source's own registrable domain (e.g. "mail.example.com"
  // when the source is "example.com") is never a third-party tracking
  // redirect, regardless of which label it starts with.
  if (!sameRegistrableDomain && isTrackingRedirectHost(parsed.hostname)) {
    return `URL host "${parsed.hostname}" looks like a tracking-redirect wrapper, not the release's own page — use the release's canonical URL instead.`;
  }

  if (sourceReg && urlReg && sourceReg !== urlReg) {
    return `URL host "${parsed.hostname}" doesn't match source "${sourceHost}" — use the release's canonical URL on the source's own domain.`;
  }

  if (INDEX_PATH_RE.test(parsed.pathname)) {
    return `URL "${trimmed}" looks like a listing/index page, not a specific release — use the individual entry's URL, or omit the field if none exists.`;
  }

  return null;
}

// ── Date plausibility ────────────────────────────────────────────────

/**
 * Reject future dates (beyond a small clock-skew allowance), epoch/zero
 * defaults, and dates implausibly older than the window being extracted.
 *
 * Returns null when the date is acceptable or absent (omitting publishedAt is
 * valid per the tool schema).
 */
export function checkDatePlausibility(
  publishedAt: string | undefined,
  opts: ValidateRecordsOptions,
): string | null {
  if (!publishedAt || !publishedAt.trim()) return null;
  const trimmed = publishedAt.trim();

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return `Date "${trimmed}" could not be parsed as ISO 8601 — re-read the source date and resubmit.`;
  }

  const clockSkewMs = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const now = Date.now();
  if (parsed.getTime() > now + clockSkewMs) {
    return `Date "${trimmed}" (parsed as ${parsed.toISOString()}) is in the future — re-read the source date; it's likely misread or the wrong field.`;
  }

  // Epoch/zero-default placeholders — parsers sometimes emit these instead of
  // omitting the field.
  if (parsed.getUTCFullYear() <= 1971) {
    return `Date "${trimmed}" (parsed as ${parsed.toISOString()}) looks like an epoch/placeholder default — omit publishedAt if no real date is recoverable.`;
  }

  const maxAgeYears = opts.maxAgeYears ?? DEFAULT_MAX_AGE_YEARS;
  const oldestPlausible = new Date(now);
  oldestPlausible.setUTCFullYear(oldestPlausible.getUTCFullYear() - maxAgeYears);
  if (parsed.getTime() < oldestPlausible.getTime()) {
    return `Date "${trimmed}" (parsed as ${parsed.toISOString()}) is implausibly old for this extraction window — re-read the source date and resubmit.`;
  }

  return null;
}

// ── Empty / boilerplate content ──────────────────────────────────────

/** Heuristic phrases indicating page chrome rather than release content. Kept
 *  small and precise — false negatives (missing a chrome page) are preferred
 *  over false positives (rejecting real content). */
const CHROME_PHRASES = [
  "accept all cookies",
  "accept cookies",
  "cookie policy",
  "we use cookies",
  "this website uses cookies",
  "subscribe to our newsletter",
  "sign up for our newsletter",
  "all rights reserved",
  "skip to main content",
  "skip to content",
  "toggle navigation",
  "toggle menu",
];

function normalizedWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Reject entries with no recoverable content (empty title AND empty body) and
 * bodies that are clearly page chrome (cookie-banner/nav-shell heuristics).
 * Kept intentionally simple and precise — favors false negatives (letting
 * borderline content through to post-hoc validation) over false positives.
 *
 * A non-empty title with an empty body is accepted: real feeds legitimately
 * carry bodyless entries (a bare version bump with no changelog text), and a
 * model can't "correct" content that genuinely doesn't exist — rejecting it
 * would just burn the retry budget for no gain.
 */
export function checkContentQuality(entry: { title?: string; content?: string }): string | null {
  const title = entry.title?.trim() ?? "";
  const content = entry.content?.trim() ?? "";

  if (!title && !content) {
    return `Entry has an empty title and empty content — every entry needs at least a real title.`;
  }
  if (!title) {
    return `Entry has an empty title — every entry needs a real title.`;
  }
  if (!content) {
    // Empty body with a real title is accepted (e.g. a version-bump entry
    // with no changelog text) — nothing further to check.
    return null;
  }

  // A body that's almost entirely a chrome phrase (short overall, and matches
  // one of the boilerplate markers) is very likely nav/cookie-banner scrape
  // residue, not release content — distinct from the now-accepted empty-body
  // case above: this is chrome *residue*, not an honestly empty entry.
  const lowerContent = content.toLowerCase();
  const looksLikeChrome =
    normalizedWordCount(content) <= 40 &&
    CHROME_PHRASES.some((phrase) => lowerContent.includes(phrase));
  if (looksLikeChrome) {
    return `Entry "${title}" content looks like page chrome (cookie banner / nav shell), not release content — re-extract the actual article body.`;
  }

  return null;
}

// ── Combined per-record + fail-open wrapper ─────────────────────────

/**
 * Run all in-band checks against one candidate entry. Returns the first
 * failing reason, or null if the entry passes.
 */
function validateOneRecord(entry: ExtractedEntry, opts: ValidateRecordsOptions): string | null {
  return (
    checkContentQuality(entry) ??
    checkUrlSanity(entry.url, opts.sourceUrl) ??
    checkDatePlausibility(entry.publishedAt, opts)
  );
}

/**
 * Validate every candidate record from an `extract_releases` call.
 *
 * Fail-open by design (#1874): if a check throws for any reason, that record
 * is treated as accepted and logged via `logEvent`, rather than blocking the
 * loop — existing post-hoc validation is the backstop for anything that
 * slips through here.
 */
export function validateRecords(
  entries: ExtractedEntry[],
  opts: ValidateRecordsOptions,
): RecordValidationRejection[] {
  const rejections: RecordValidationRejection[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    try {
      const reason = validateOneRecord(entry, opts);
      if (reason) rejections.push({ index, reason });
    } catch (err) {
      logEvent("warn", {
        component: "extract-with-tools",
        event: "record-validation-check-failed",
        index,
        sourceUrl: opts.sourceUrl,
        err,
      });
      // Fail-open: do not reject on validator-infrastructure errors.
    }
  }
  return rejections;
}

/** Format a rejection list into an actionable tool_result message for the model. */
export function formatRejectionMessage(
  rejections: RecordValidationRejection[],
  totalCount: number,
): string {
  const lines = rejections.map((r) => `- Entry ${r.index + 1} of ${totalCount}: ${r.reason}`);
  return (
    `${rejections.length} of ${totalCount} entries were rejected and NOT recorded:\n` +
    `${lines.join("\n")}\n\n` +
    `Call extract_releases again with corrected entries for the rejected ones. ` +
    `Entries not listed above were fine — you don't need to resubmit them, but you may include them again if it's simpler to resend the full corrected set.`
  );
}
