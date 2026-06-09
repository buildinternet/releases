// Source-of-truth for the deterministic logic that update-overviews.ts INLINES
// verbatim (Workflow scripts can't import). Unit-tested here;
// tests/workflows/workflow-scripts.test.ts guards the inlined copies against drift.
// Keep this annotation-free inside the function bodies so they match the inlined
// plain-JS copies byte-for-byte (modulo whitespace, which the guard normalizes).

/**
 * Decide which selection mode a set of workflow args implies.
 * Precedence: explicit orgs list > release-activity window > overview-age window > outdated.
 * @param {object} input parsed workflow args
 * @returns {"orgs"|"activity"|"overviewAge"|"outdated"}
 */
export function inferSelectionMode(input) {
  const a = input || {};
  if (Array.isArray(a.orgs) && a.orgs.length > 0) return "orgs";
  if (a.activeSince != null || a.activeUntil != null) return "activity";
  if (a.overviewUpdatedFrom != null || a.overviewUpdatedTo != null) return "overviewAge";
  return "outdated";
}

/**
 * Keep manifest rows whose date `field` falls within [from, to], comparing on the
 * calendar-date part only so a bare `to` date is inclusive of the whole day.
 * Rows with a null/absent field are dropped (can't window them). ISO-8601 strings
 * compare lexically, so date-part string comparison is chronological.
 * @param {Array<object>} rows
 * @param {string} field e.g. "overviewUpdatedAt" or "orgLastActivity"
 * @param {string|null|undefined} from inclusive lower bound (ISO date), null = open
 * @param {string|null|undefined} to inclusive upper bound (ISO date), null = open
 * @returns {Array<object>}
 */
export function filterByDateWindow(rows, field, from, to) {
  const lo = from ? String(from).slice(0, 10) : null;
  const hi = to ? String(to).slice(0, 10) : null;
  return (rows || []).filter((r) => {
    if (!r || r[field] == null) return false;
    const d = String(r[field]).slice(0, 10);
    if (lo && d < lo) return false;
    if (hi && d > hi) return false;
    return true;
  });
}

/**
 * Single-pass decode of the five HTML entities sub-agents reflexively over-escape
 * when relaying markdown back as a message. Single pass so `&amp;lt;` stays `&lt;`.
 * In-repo sibling with the same five-entity contract: `decodeHtmlEntities` in
 * packages/ai/src/overview-citations.ts (server-side batch path). Independent copies —
 * the workflow can't import, so this stays standalone like backfill-helpers.js.
 * @param {string} s
 * @returns {string}
 */
export function unescapeHtmlEntities(s) {
  if (typeof s !== "string") return s;
  const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => map[m]);
}

/**
 * Extract a body's opening "sentence": the run up to the first sentence-final
 * punctuation (`. ! ?` followed by whitespace or end), else the first line.
 * Returned RAW (markdown emphasis intact) because callers differ — the opener
 * word-count strips `*`_`, but lintOverviewBody's org-as-subject check needs the
 * leading `**` to survive. Shared by lintOverviewBody and the workflow's
 * openerWordCount so the corrective hint's count can't drift from the lint rule.
 * @param {string} body
 * @returns {string}
 */
export function extractOpener(body) {
  const text = typeof body === "string" ? body : "";
  const trimmed = text.trim();
  const sm = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (sm ? sm[0] : trimmed.split("\n")[0] || "").trim();
}

/**
 * Lint an overview body against the maintaining-orgs HARD style rules. Returns a
 * list of violation codes (empty = clean). Operates on the already-decoded body.
 * @param {string} body
 * @param {string} orgName
 * @returns {string[]}
 */
export function lintOverviewBody(body, orgName) {
  const text = typeof body === "string" ? body : "";
  const violations = [];
  if (/^#{1,6}\s/m.test(text)) violations.push("markdown-heading");
  const opener = extractOpener(text);
  const openerWords = opener.replace(/[*`_]/g, "").split(/\s+/).filter(Boolean);
  if (openerWords.length > 25) violations.push("opener-too-long");
  const name = typeof orgName === "string" ? orgName.trim() : "";
  if (name) {
    const rest = opener.replace(/^\**\s*/, "");
    if (rest.toLowerCase().startsWith(name.toLowerCase())) {
      const remainder = rest.slice(name.length);
      if (/^['’]s\b/.test(remainder) || /^\s+[a-z]/.test(remainder)) {
        violations.push("org-as-subject-opener");
      }
    }
  }
  for (const m of text.matchAll(/\*\*\s*([^*]+?)\s*\*\*/g)) {
    if (/^(v?\d+(\.\d+)+|CVE-\d)/i.test(m[1].trim())) {
      violations.push("version-lead-tease");
      break;
    }
  }
  const banned = [
    "biggest",
    "doubling down",
    "leap forward",
    "in the best sense",
    "powerful",
    "seamless",
    "comprehensive",
    "world-class",
    "best-in-class",
    "transformative",
    "next-generation",
    "cutting-edge",
  ];
  for (const p of banned) {
    const re = new RegExp("\\b" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(text)) violations.push("banned-phrase:" + p);
  }
  return violations;
}

/**
 * Re-derive citation offsets in-parent (UTF-16 code units, so JS) by locating each
 * `citedText` in the decoded body. Drops citations whose text isn't found or whose
 * span overlaps an already-accepted one. Sidesteps the API's 400 bad_citations.
 * @param {string} body decoded, trailing-newline-trimmed
 * @param {Array<{sourceUrl?:string,title?:string,citedText?:string}>} citations
 * @returns {{citations:Array<object>, dropped:number}}
 */
export function deriveCitationOffsets(body, citations) {
  const text = typeof body === "string" ? body : "";
  const accepted = [];
  const spans = [];
  let dropped = 0;
  for (const c of citations || []) {
    const citedText = c && typeof c.citedText === "string" ? c.citedText : "";
    if (!citedText) {
      dropped++;
      continue;
    }
    // Use the first occurrence that doesn't overlap an accepted span, so a
    // repeated phrase can still cite a later copy when its first hit is taken.
    let start = -1;
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(citedText, from);
      if (idx < 0) break;
      if (!spans.some((s) => idx < s.end && idx + citedText.length > s.start)) {
        start = idx;
        break;
      }
      from = idx + 1;
    }
    if (start < 0) {
      dropped++;
      continue;
    }
    const end = start + citedText.length;
    spans.push({ start, end });
    accepted.push({
      startIndex: start,
      endIndex: end,
      sourceUrl: c.sourceUrl,
      title: c.title,
      citedText,
    });
  }
  return { citations: accepted, dropped };
}

/**
 * Budget gate for the per-org generation waves. Mirrors backfill-helpers' budgetGate
 * shape with org-appropriate wording. No ceiling (null total) never stops.
 * @param {number|null} total budget.total
 * @param {number} remaining budget.remaining()
 * @param {number} reserve per-wave token reserve
 * @param {number} done orgs generated so far
 * @param {number} totalTargets
 * @returns {{stop:boolean, logLine?:string}}
 */
export function budgetGate(total, remaining, reserve, done, totalTargets) {
  if (!total) return { stop: false };
  if (remaining >= reserve) return { stop: false };
  const deferred = totalTargets - done;
  return {
    stop: true,
    logLine: `budget gate: ${remaining} tokens left (< ${reserve} reserve); stopping at ${done}/${totalTargets}, ${deferred} orgs deferred — re-run to continue (idempotent)`,
  };
}
