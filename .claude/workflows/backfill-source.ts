export const meta = {
  name: "backfill-source",
  description:
    "Local full-history backfill of one changelog source: preflight-gated, window-capped, budget-gated index→detail extraction written via the idempotent /batch upsert — no managed-agent inference bill.",
  whenToUse:
    "Backfill a source's changelog history locally without the managed-agent extraction bill. Dry-run first (the default). Launch via the backfilling-sources skill.",
  phases: [
    { title: "Preflight", detail: "robots/Content-Signal gate (fail-closed) + run setup" },
    { title: "Map", detail: "enumerate detail URLs, diff against ingested, cap" },
    { title: "Extract", detail: "agent-per-page records (Sonnet), budget-gated waves" },
    { title: "Write", detail: "chunked /batch upsert (Haiku)" },
    { title: "Report", detail: "validate + run summary to ~/.releases/work" },
  ],
};

// ── Tunables ──────────────────────────────────────────────────────────────
const WAVE = 8; // pages extracted concurrently per budget-checked wave
const PER_WAVE_RESERVE = 60000; // stop scheduling a new wave when budget.remaining() drops below this
const CHUNK_SIZE = 50; // records per /batch POST

// ── Inlined deterministic helpers ──────────────────────────────────────────
// MIRRORED VERBATIM from tests/workflows/backfill-helpers.js (Workflow scripts
// can't import). Unit-tested there; workflow-scripts.test.ts guards drift.
// Do not edit here without editing the module — the drift guard will fail.

function preflightDecision(verdict, attempt) {
  if (verdict === "proceed") return { action: "proceed" };
  if (verdict === "refuse") return { action: "stop", status: "refused" };
  if (attempt < 2) return { action: "retry" };
  return { action: "stop", status: "blocked-unknown" };
}

function selectNewUrls(discovered, known) {
  const knownSet = new Set(known);
  const freshSet = new Set();
  const knownHits = new Set();
  for (const u of discovered) {
    if (knownSet.has(u)) knownHits.add(u);
    else freshSet.add(u);
  }
  return { fresh: [...freshSet], skippedKnown: knownHits.size };
}

function applyCap(fresh, maxReleases) {
  const targets = fresh.slice(0, maxReleases);
  const deferred = fresh.length - targets.length;
  const logLine =
    deferred > 0
      ? `mapped ${fresh.length} new pages; capping to ${targets.length} (maxReleases=${maxReleases}); skipping ${deferred} older — re-run with a higher cap to go deeper`
      : `mapped ${fresh.length} new pages; all within cap (maxReleases=${maxReleases})`;
  return { targets, capped: targets.length, deferred, logLine };
}

function budgetGate(total, remaining, reserve, done, totalTargets) {
  if (!total) return { stop: false };
  if (remaining >= reserve) return { stop: false };
  const deferred = totalTargets - done;
  return {
    stop: true,
    logLine: `budget gate: ${remaining} tokens left (< ${reserve} reserve); stopping at ${done}/${totalTargets}, ${deferred} pages deferred — re-run to continue (idempotent)`,
  };
}

function cleanVersion(v) {
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

function dedupeRecords(records) {
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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function finalStatus(deferredForBudget) {
  return deferredForBudget > 0 ? "partial-budget" : "completed";
}

function summaryPath(runDir, slug, nested) {
  if (!runDir) return null;
  return runDir + "/" + (nested ? `summary-${slug}.md` : "summary.md");
}

function altitudeSanity(records, granularity) {
  const months = new Set();
  for (const r of records || []) {
    const p = r && typeof r.publishedAt === "string" ? r.publishedAt.slice(0, 7) : "";
    if (/^\d{4}-\d{2}$/.test(p)) months.add(p);
  }
  const recordCount = (records || []).length;
  const monthCount = months.size;
  if (recordCount === 0 || monthCount === 0) return null;
  const perMonth = recordCount / monthCount;
  if (granularity === "feature" || perMonth <= 4) return null;
  const hint = granularity ? `granularity="${granularity}"` : "no granularity hint set";
  return `altitude check: ${recordCount} records across ${monthCount} month(s) (~${perMonth.toFixed(1)}/mo), ${hint} — confirm the intended altitude (feature | period | version | rollup); pin it via source metadata.granularity.`;
}

// ── Schemas (forced structured output) ──────────────────────────────────────
const PREFLIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["proceed", "refuse", "unknown"] },
    sitemaps: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["verdict"],
};
const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    structure: { type: "string", enum: ["single-page", "index", "unknown"] },
    pages: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["structure", "pages"],
};
const RECORDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pageUrl: { type: "string" },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: ["string", "null"] },
          title: { type: "string" },
          content: { type: "string" },
          url: { type: "string" },
          publishedAt: { type: ["string", "null"] },
          media: { type: ["string", "null"] },
          type: { type: ["string", "null"], enum: ["feature", "rollup", null] },
          prerelease: { type: ["boolean", "null"] },
        },
        required: ["title", "content", "url"],
      },
    },
  },
  required: ["pageUrl", "records"],
};
const WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    written: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["written"],
};
const VALIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    count: { type: "number" },
    emptyContent: { type: "number" },
    sampleTitles: { type: "array", items: { type: "string" } },
  },
  required: ["count"],
};

// ── Local label/prompt helpers (not shared; fine to keep here) ───────────────
function short(u) {
  try {
    const segs = new URL(u).pathname.split("/").filter(Boolean);
    return (segs[segs.length - 1] || u).slice(0, 40);
  } catch {
    return String(u).slice(0, 40);
  }
}
// Per-altitude split instruction injected when the source pins metadata.granularity
// (#1409), so the record altitude is deterministic across runs instead of a per-run
// judgment call by the extractor. Empty string when no hint is set (today's behavior).
function granularityGuide(g) {
  switch (g) {
    case "feature":
      return "one record per distinct feature/change (split multi-item sections into individual entries)";
    case "period":
      return "one record per time-period heading (month/quarter), collecting that period's changes into a single entry";
    case "version":
      return "one record per version / released build";
    case "rollup":
      return "one coarse record per logical release grouping (do not split into individual features)";
    default:
      return "";
  }
}
function extractPrompt(url, singlePage, granularity) {
  const guide = granularityGuide(granularity);
  const altitude = guide
    ? `\nGRANULARITY = "${granularity}" — extract at this altitude: ${guide}. Keep the record count consistent with this altitude on every run.`
    : "";
  return `Fetch ${url} and extract ${singlePage ? "EVERY changelog entry on the page" : "the release(s) on this page"} as records for the Releases /batch upsert.${altitude}
Per record: { version?, title (required), content (required, markdown), url (REQUIRED — stable per-release URL; for a single-page changelog use ${url}#<slug-anchor>), publishedAt? (ISO-8601; approximate a month/quarter/year heading to a date rather than omit), media? (UNWRAP _next/image and Vercel optimizer wrappers to the underlying CDN URL), type? ("feature"|"rollup"), prerelease? }.
Rules: ALWAYS populate url (the dedup key). Never invent a version — omit if absent. Return { pageUrl: "${url}", records: [...] }.`;
}

// ── args ─────────────────────────────────────────────────────────────────────
let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    /* report below */
  }
}
input = input || {};
const SOURCE = input.source;
if (input.maxReleases != null && !(Number.isInteger(input.maxReleases) && input.maxReleases > 0)) {
  log(`backfill-source: maxReleases must be a positive integer, got ${input.maxReleases}`);
  return { status: "error", error: "invalid maxReleases" };
}
const MAX = input.maxReleases == null ? 50 : input.maxReleases;
const DRY = input.dryRun !== false; // default true
const EXTRACT_MODEL = input.model === "haiku" ? "haiku" : "sonnet";
// A parent sweep passes its own already-created run dir so all sources share one
// run without going through the shared `.current-run` pointer (#1396). Absolute
// paths only; anything else is ignored and we mint our own isolated run.
const PARENT_RUN_DIR =
  typeof input.runDir === "string" && input.runDir.startsWith("/") ? input.runDir : null;
if (!SOURCE) {
  log("backfill-source: missing required `source` arg");
  return { status: "error", error: "missing source" };
}
const slugForDir = String(SOURCE)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// ── Phase: Preflight ─────────────────────────────────────────────────────────
phase("Preflight");
const resolved = await agent(
  `Resolve the Releases source "${SOURCE}" and return its identifiers.
Run \`releases admin source get ${SOURCE} --json\`. SOURCE may be a human slug, a typed \`src_…\` id, or an http(s) URL — if it is a URL and the command can't resolve it directly, look it up via \`releases lookup domain <domain> --json\` or \`releases admin source list --json\` and match the URL.
Return: the typed \`src_…\` id (REQUIRED — the batch write needs it; the human slug 400s on the bare path), the canonical human URL, the source slug, the org slug, and \`granularity\` = the source's \`metadata.granularity\` if set (one of feature|period|version|rollup), else null.`,
  {
    label: "resolve-source",
    phase: "Preflight",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        url: { type: "string" },
        slug: { type: "string" },
        org: { type: ["string", "null"] },
        granularity: {
          type: ["string", "null"],
          enum: ["feature", "period", "version", "rollup", null],
        },
      },
      required: ["id", "url", "slug"],
    },
  },
);
if (!resolved || !resolved.id || !resolved.url || !resolved.slug) {
  log("preflight: could not resolve source (need typed src_ id + url + slug)");
  return { status: "error", error: "unresolved source" };
}
// Altitude hint (#1409): pins how finely the extractor splits records so the count
// is deterministic across runs. Only the known values are honored; anything else
// (or absent) leaves the extract prompt at its default, unguided behavior.
const GRANULARITY =
  resolved.granularity && ["feature", "period", "version", "rollup"].includes(resolved.granularity)
    ? resolved.granularity
    : null;

let verdict = "unknown",
  sitemaps = [],
  attempt = 0,
  decision = { action: "retry" };
do {
  attempt++;
  const pf = await agent(
    `Run the local-ingest opt-out preflight and report its verdict EXACTLY.
Command: \`bun src/agent/skills/local-ingest/preflight.ts ${resolved.url} --json\`
Exit 0 → "proceed", exit 1 → "refuse", exit 2 → "unknown". Return the verdict, the sitemaps array it prints, and a one-line reason.`,
    { label: `preflight#${attempt}`, phase: "Preflight", model: "haiku", schema: PREFLIGHT_SCHEMA },
  );
  verdict = (pf && pf.verdict) || "unknown";
  if (pf && Array.isArray(pf.sitemaps)) sitemaps = pf.sitemaps;
  decision = preflightDecision(verdict, attempt);
} while (decision.action === "retry");
if (decision.action === "stop") {
  log(`preflight: ${verdict} → ${decision.status}; not fetching or writing.`);
  return { status: decision.status, source: SOURCE, url: resolved.url };
}

// Own an ISOLATED maintenance run. We deliberately do NOT `work start` — that
// writes the shared global `.current-run` pointer, and any concurrent `releases
// admin` write in another session resolves it and leaks into our run (#1396). A
// parent sweep passes its already-created run dir (PARENT_RUN_DIR) so siblings
// share one run; standalone, we mint a fresh timestamped dir directly (same
// layout/naming as the CLI's startRun → run-dir.ts, honoring RELEASES_DATA_DIR)
// without ever touching the pointer. Skipped on a dry-run (#1408): it returns
// before the Report phase, so no run dir / summary is ever written.
let RUN_DIR = PARENT_RUN_DIR;
if (!RUN_DIR && !DRY) {
  const runInfo = await agent(
    `Create an ISOLATED maintenance run dir for this backfill. Do NOT run \`releases admin work start\` (it sets a shared pointer that leaks across sessions). Run exactly this, then return the absolute dir it prints:
\`\`\`
base="\${RELEASES_DATA_DIR:-\${RELEASED_DATA_DIR:-$HOME/.releases}}/work"
dir="$base/runs/$(date +%Y-%m-%d-%H%M)-backfill-${slugForDir}"
mkdir -p "$dir" "$base/tasks" "$base/reports"
echo "$dir"
\`\`\`
Return runDir = the absolute path printed (it must start with / and end in -backfill-${slugForDir}).`,
    {
      label: "run-setup",
      phase: "Preflight",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { runDir: { type: "string" } },
        required: ["runDir"],
      },
    },
  );
  RUN_DIR =
    runInfo && typeof runInfo.runDir === "string" && runInfo.runDir.startsWith("/")
      ? runInfo.runDir
      : null;
}
if (!RUN_DIR && !DRY)
  log("run-setup: could not resolve an isolated run dir — summary won't be written");
// Under a sweep, sibling sources share one run dir, so namespace each summary by
// slug to avoid clobbering. Standalone runs keep the canonical `summary.md`.
const SUMMARY_PATH = summaryPath(RUN_DIR, slugForDir, !!PARENT_RUN_DIR);

// ── Phase: Map ───────────────────────────────────────────────────────────────
phase("Map");
const mapped = await agent(
  `Map the changelog at ${resolved.url} into per-release detail-page URLs.
1. Classify shape: \`releases admin discovery evaluate ${resolved.url} --json\` → read pageStructure (single-page | index | unknown).
2. single-page → return structure "single-page", pages=[${JSON.stringify(resolved.url)}] (it is entry-split during extraction).
3. index/unknown → enumerate per-release detail URLs. Prefer these sitemaps filtered to the changelog path: ${JSON.stringify(sitemaps)}. If none usable, fetch ${resolved.url} and parse the index HTML for per-release links.
Order the list STRICTLY newest-first — the workflow's window cap keeps the FIRST \`maxReleases\` entries and skips the rest, so wrong ordering silently drops the newest releases. Return the structure and the FULL discovered list (do not cap — the workflow caps).`,
  { label: "map-pages", phase: "Map", model: "sonnet", schema: MAP_SCHEMA },
);
const structure = (mapped && mapped.structure) || "unknown";
const discovered = mapped && Array.isArray(mapped.pages) ? mapped.pages : [];

// Single-page sources skip the known-URL lookup (#1408): their releases are stored
// as `pageUrl#anchor`, so the bare page URL never matches a known release URL
// (skippedKnown is always 0) and the /batch upsert is idempotent anyway — the agent
// call is pure waste. Index/unknown shapes still dedup against already-ingested URLs.
let knownUrls = [];
if (structure !== "single-page") {
  const known = await agent(
    `List the release URLs ALREADY ingested for source "${resolved.slug}" so we don't re-extract them. Get as complete a list as the tooling allows — \`releases tail ${resolved.slug}\` only shows the most recent rows, so prefer a high count / the list API (e.g. \`releases tail ${resolved.slug} --json -c 500\`, falling back to whatever the command accepts). Return the array of release \`url\` values, omitting any null/empty urls (\`[]\` if none).`,
    {
      label: "known-urls",
      phase: "Map",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { urls: { type: "array", items: { type: "string" } } },
        required: ["urls"],
      },
    },
  );
  knownUrls = (known && known.urls) || [];
}
const { fresh, skippedKnown } = selectNewUrls(discovered, knownUrls);
const { targets, capped, deferred: cappedOut, logLine: capLog } = applyCap(fresh, MAX);
log(capLog);

if (DRY) {
  log(
    `dry-run: structure=${structure}, discovered=${discovered.length}, alreadyIngested=${skippedKnown}, wouldExtract=${capped}, cappedOut=${cappedOut}`,
  );
  return {
    status: "dry-run",
    source: SOURCE,
    url: resolved.url,
    structure,
    discovered: discovered.length,
    skippedKnown,
    capped,
    cappedOut,
    samplePages: targets.slice(0, 5),
    note: "Re-invoke with dryRun:false to extract + write. Set a turn budget (+Nk) to cap spend.",
  };
}

// ── Phase: Extract ───────────────────────────────────────────────────────────
phase("Extract");
// One loop for both shapes: a single-page changelog is just one entry-split page
// (step 1), an index is waves of WAVE. `parallel()` over a 1-element array is a
// no-op, so the budget gate + accumulate logic lives in exactly one place.
const allRecords = [];
const singlePage = structure === "single-page";
const step = singlePage ? 1 : WAVE;
let done = 0,
  deferredForBudget = 0;
for (let i = 0; i < targets.length; i += step) {
  const gate = budgetGate(budget.total, budget.remaining(), PER_WAVE_RESERVE, done, targets.length);
  if (gate.stop) {
    log(gate.logLine);
    deferredForBudget = targets.length - done;
    break;
  }
  const wave = targets.slice(i, i + step);
  const results = await parallel(
    wave.map(
      (u) => () =>
        agent(extractPrompt(u, singlePage, GRANULARITY), {
          label: `extract:${short(u)}`,
          phase: "Extract",
          model: EXTRACT_MODEL,
          schema: RECORDS_SCHEMA,
        }),
    ),
  );
  for (const r of results) if (r && Array.isArray(r.records)) allRecords.push(...r.records);
  done += wave.length;
}

// ── Phase: Write ─────────────────────────────────────────────────────────────
phase("Write");
const { kept, dropped, reasons } = dedupeRecords(allRecords);
const batches = chunk(kept, CHUNK_SIZE);
let written = 0;
const writeErrors = [];
if (kept.length) {
  const writeRes = await agent(
    `POST these ${kept.length} already-deduped+cleaned release records to the Releases batch upsert for source "${resolved.slug}". They are pre-split into ${batches.length} chunk(s) (≤${CHUNK_SIZE} each — the D1 100-bind limit). POST each chunk as its own request, writing it to a temp file first:
\`\`\`
curl -sS -X POST "$RELEASES_API_URL/v1/sources/${resolved.id}/releases/batch" -H "Authorization: Bearer $RELEASES_API_KEY" -H "Content-Type: application/json" -d @chunk.json
\`\`\`
Each request body is { "releases": [ ...one chunk... ] }. Report how many were written and any non-2xx responses.
CHUNKS_JSON (an array of chunks; POST each element verbatim, do not alter or re-chunk): ${JSON.stringify(batches)}`,
    { label: "batch-write", phase: "Write", model: "haiku", schema: WRITE_SCHEMA },
  );
  written = (writeRes && writeRes.written) || 0;
  if (writeRes && Array.isArray(writeRes.errors)) writeErrors.push(...writeRes.errors);
}

// ── Phase: Report ────────────────────────────────────────────────────────────
phase("Report");
const validation = await agent(
  `Validate the backfill for source "${resolved.slug}": run \`releases tail ${resolved.slug} --json\` and report the total count, how many have empty content, and up to 5 sample titles.`,
  { label: "validate", phase: "Report", model: "haiku", schema: VALIDATE_SCHEMA },
);
// Altitude sanity (#1409): surface when the record count is high relative to the
// date span it covers, so over-/under-splitting is visible in the log + summary
// rather than a silent per-run judgment. Null when nothing looks anomalous.
const altitudeNote = altitudeSanity(kept, GRANULARITY);
if (altitudeNote) log(altitudeNote);
const status = finalStatus(deferredForBudget);
const spentTokens = Math.round(budget.spent());
const summaryInputs = {
  source: SOURCE,
  slug: resolved.slug,
  url: resolved.url,
  structure,
  status,
  discovered: discovered.length,
  skippedKnown,
  capped,
  written,
  dropped,
  dropReasons: reasons,
  deferredForBudget,
  writeErrors,
  validation,
  altitudeNote,
  spentTokens,
};
// Deterministic report path: computed in-script (SUMMARY_PATH), not re-resolved by
// the agent from the racy active-run pointer. No run dir → skip the report.
let rep = null;
if (!SUMMARY_PATH) {
  log("report: no isolated run dir — skipping summary.md (results are in the return value)");
} else {
  rep = await agent(
    `Write the maintenance run summary for this backfill to this EXACT absolute path (do not derive it from \`work status\` — it is already resolved): ${SUMMARY_PATH}

Steps IN ORDER:
1. Write the file at ${SUMMARY_PATH} following docs/architecture/maintenance-workspace.md's summary.md template (status, per-target counts table, cost, what changed, findings). Use these numbers VERBATIM (do not invent): ${JSON.stringify(summaryInputs)}.
   Cost line, exactly: "${spentTokens} output tokens this turn (budget.spent(), excludes this summary write); session sub-agent tokens, no managed-agent bill." Stamp the date via \`date -u +%FT%TZ\`. Surface data-quality findings (empty content, thin pages, deferred-for-budget pages, write errors).
2. Self-verify it landed at that exact path: run \`test -f "${SUMMARY_PATH}" && echo EXISTS || echo MISSING\`. If MISSING, write it again and re-check. Only set wrote=true once the check prints EXISTS.
3. Do NOT run \`releases admin work end\` — this workflow does not use the shared run pointer.
4. Return reportPath=${SUMMARY_PATH} and wrote = whether the test -f check printed EXISTS.`,
    {
      label: "run-report",
      phase: "Report",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reportPath: { type: "string" },
          wrote: { type: "boolean" },
        },
        required: ["reportPath", "wrote"],
      },
    },
  );
  if (!rep || !rep.wrote) {
    log(
      `WARNING: run-report agent did not confirm summary landed at ${SUMMARY_PATH} (wrote=${rep?.wrote}). Write it by hand from the return value.`,
    );
  }
}

return {
  status,
  source: SOURCE,
  url: resolved.url,
  structure,
  discovered: discovered.length,
  skippedKnown,
  capped,
  extracted: done,
  written,
  dropped,
  deferredForBudget,
  actualCostTokens: spentTokens,
  runDir: RUN_DIR,
  reportPath: SUMMARY_PATH,
  reportWritten: !!(rep && rep.wrote),
};
