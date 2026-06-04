// Source-of-truth for the deterministic decision logic that backfill-source.ts
// INLINES verbatim (Workflow scripts can't import). Unit-tested here;
// tests/workflows/workflow-scripts.test.ts guards the inlined copies against drift.
// Keep this annotation-free so the bodies match the inlined plain-JS copies.

/**
 * @param {"proceed"|"refuse"|"unknown"} verdict
 * @param {number} attempt 1 on first check, 2 after one retry
 * @returns {{action:"proceed"|"retry"|"stop", status?:string}}
 */
export function preflightDecision(verdict, attempt) {
  if (verdict === "proceed") return { action: "proceed" };
  if (verdict === "refuse") return { action: "stop", status: "refused" };
  if (attempt < 2) return { action: "retry" };
  return { action: "stop", status: "blocked-unknown" };
}

/**
 * @param {string[]} discovered
 * @param {string[]} known
 * @returns {{fresh:string[], skippedKnown:number}}
 */
export function selectNewUrls(discovered, known) {
  const knownSet = new Set(known);
  const freshSet = new Set();
  const knownHits = new Set();
  for (const u of discovered) {
    if (knownSet.has(u)) knownHits.add(u);
    else freshSet.add(u);
  }
  return { fresh: [...freshSet], skippedKnown: knownHits.size };
}

/**
 * @param {string[]} fresh newest-first
 * @param {number} maxReleases
 * @returns {{targets:string[], capped:number, deferred:number, logLine:string}}
 */
export function applyCap(fresh, maxReleases) {
  const targets = fresh.slice(0, maxReleases);
  const deferred = fresh.length - targets.length;
  const logLine =
    deferred > 0
      ? `mapped ${fresh.length} new pages; capping to ${targets.length} (maxReleases=${maxReleases}); skipping ${deferred} older — re-run with a higher cap to go deeper`
      : `mapped ${fresh.length} new pages; all within cap (maxReleases=${maxReleases})`;
  return { targets, capped: targets.length, deferred, logLine };
}

/**
 * @param {number|null} total budget.total (null = no ceiling)
 * @param {number} remaining budget.remaining()
 * @param {number} reserve per-wave token reserve
 * @param {number} done pages extracted so far
 * @param {number} totalTargets
 * @returns {{stop:boolean, logLine?:string}}
 */
export function budgetGate(total, remaining, reserve, done, totalTargets) {
  if (!total) return { stop: false };
  if (remaining >= reserve) return { stop: false };
  const deferred = totalTargets - done;
  return {
    stop: true,
    logLine: `budget gate: ${remaining} tokens left (< ${reserve} reserve); stopping at ${done}/${totalTargets}, ${deferred} pages deferred — re-run to continue (idempotent)`,
  };
}

/**
 * @param {string|null|undefined} v
 * @returns {string|undefined}
 */
export function cleanVersion(v) {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (
    lower === "<unknown>" ||
    lower === "unknown" ||
    lower === "n/a" ||
    lower === "na" ||
    lower === "none"
  )
    return undefined;
  return t;
}

/**
 * @param {Array<object>} records
 * @returns {{kept:Array<object>, dropped:number, reasons:{missingUrl:number,missingTitleOrContent:number,duplicate:number}}}
 */
export function dedupeRecords(records) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  const reasons = { missingUrl: 0, missingTitleOrContent: 0, duplicate: 0 };
  for (const r of records || []) {
    if (!r || !r.url) {
      dropped++;
      reasons.missingUrl++;
      continue;
    }
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const content = typeof r.content === "string" ? r.content.trim() : "";
    if (!title || !content) {
      dropped++;
      reasons.missingTitleOrContent++;
      continue;
    }
    if (seen.has(r.url)) {
      dropped++;
      reasons.duplicate++;
      continue;
    }
    seen.add(r.url);
    const v = cleanVersion(r.version);
    const out = { ...r, title, content };
    if (v === undefined) delete out.version;
    else out.version = v;
    kept.push(out);
  }
  return { kept, dropped, reasons };
}

/**
 * @param {Array<any>} arr
 * @param {number} size
 * @returns {Array<Array<any>>}
 */
export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {number} deferredForBudget
 * @returns {"completed"|"partial-budget"}
 */
export function finalStatus(deferredForBudget) {
  return deferredForBudget > 0 ? "partial-budget" : "completed";
}

/**
 * Per-source summary path inside a run dir. Standalone runs use the canonical
 * `summary.md`; under a sweep (nested), siblings share one run dir so each
 * summary is namespaced by slug to avoid clobbering. Null run dir → null.
 * @param {string|null} runDir
 * @param {string} slug
 * @param {boolean} nested true when a parent sweep owns the run dir
 * @returns {string|null}
 */
export function summaryPath(runDir, slug, nested) {
  if (!runDir) return null;
  return runDir + "/" + (nested ? `summary-${slug}.md` : "summary.md");
}

/**
 * Deterministic cross-run sweep report path derived from the in-script run dir:
 * `<base>/runs/<YYYY-MM-DD-HHMM>-backfill-sweep` → `<base>/reports/<YYYY-MM-DD>-backfill-sweep.md`.
 * Null run dir → null (caller falls back to an agent-stamped date).
 * @param {string|null} runDir
 * @returns {string|null}
 */
export function sweepReportPath(runDir) {
  if (!runDir) return null;
  const reportsDir = runDir.replace(/\/runs\/[^/]+$/, "/reports");
  const date = (runDir.split("/").pop() || "").slice(0, 10);
  return `${reportsDir}/${date}-backfill-sweep.md`;
}
