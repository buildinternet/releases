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
    if (!r.title || !r.content) {
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
    const out = { ...r };
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
    chunks: { type: "number" },
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
function extractPrompt(url, singlePage) {
  return `Fetch ${url} and extract ${singlePage ? "EVERY changelog entry on the page" : "the release(s) on this page"} as records for the Releases /batch upsert.
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
const MAX = Number.isFinite(input.maxReleases) ? input.maxReleases : 50;
const DRY = input.dryRun !== false; // default true
const EXTRACT_MODEL = input.model === "haiku" ? "haiku" : "sonnet";
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
  `Resolve the Releases source "${SOURCE}". Run \`releases admin source get ${SOURCE} --json\` (it may be a slug, src_ id, or http(s) URL — if already a URL, use it directly and still resolve the slug). Return the canonical human URL, the source slug, and org slug.`,
  {
    label: "resolve-source",
    phase: "Preflight",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        slug: { type: "string" },
        org: { type: ["string", "null"] },
      },
      required: ["url", "slug"],
    },
  },
);
if (!resolved || !resolved.url || !resolved.slug) {
  log("preflight: could not resolve source");
  return { status: "error", error: "unresolved source" };
}

let verdict = "unknown",
  sitemaps = [],
  attempt = 0,
  decision;
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

const runInfo = await agent(
  `Set up the maintenance run for this backfill.
1. Run \`releases admin work status --json\`.
2. If a run is active, capture its run dir, started=false.
3. If none, run \`releases admin work start backfill-${slugForDir} --json\`, capture the new run dir, started=true, and \`mkdir -p ~/.releases/work/tasks ~/.releases/work/reports\`.
Return the absolute run dir and whether you started it.`,
  {
    label: "run-setup",
    phase: "Preflight",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { runDir: { type: "string" }, started: { type: "boolean" } },
      required: ["runDir", "started"],
    },
  },
);
const RUN_DIR = (runInfo && runInfo.runDir) || null;
const WE_STARTED_RUN = !!(runInfo && runInfo.started);

// ── Phase: Map ───────────────────────────────────────────────────────────────
phase("Map");
const known = await agent(
  `List the release URLs already ingested for source "${resolved.slug}" so we skip them. Run \`releases tail ${resolved.slug} --json\` and return the array of release \`url\` values (\`[]\` if none).`,
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
const knownUrls = (known && known.urls) || [];

const mapped = await agent(
  `Map the changelog at ${resolved.url} into per-release detail-page URLs.
1. Classify shape: \`releases admin discovery evaluate ${resolved.url} --json\` → read pageStructure (single-page | index | unknown).
2. single-page → return structure "single-page", pages=[${JSON.stringify(resolved.url)}] (it is entry-split during extraction).
3. index/unknown → enumerate per-release detail URLs. Prefer these sitemaps filtered to the changelog path: ${JSON.stringify(sitemaps)}. If none usable, fetch ${resolved.url} and parse the index HTML for per-release links. Order newest-first if discernible.
Return the structure and the FULL discovered list (do not cap — the workflow caps).`,
  { label: "map-pages", phase: "Map", model: "sonnet", schema: MAP_SCHEMA },
);
const structure = (mapped && mapped.structure) || "unknown";
const discovered = mapped && Array.isArray(mapped.pages) ? mapped.pages : [];
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
const allRecords = [];
let done = 0,
  deferredForBudget = 0;
if (structure === "single-page") {
  const r = await agent(extractPrompt(targets[0] || resolved.url, true), {
    label: "extract:single",
    phase: "Extract",
    model: EXTRACT_MODEL,
    schema: RECORDS_SCHEMA,
  });
  if (r && Array.isArray(r.records)) allRecords.push(...r.records);
  done = 1;
} else {
  for (let i = 0; i < targets.length; i += WAVE) {
    const gate = budgetGate(
      budget.total,
      budget.remaining(),
      PER_WAVE_RESERVE,
      done,
      targets.length,
    );
    if (gate.stop) {
      log(gate.logLine);
      deferredForBudget = targets.length - done;
      break;
    }
    const wave = targets.slice(i, i + WAVE);
    const results = await parallel(
      wave.map(
        (u) => () =>
          agent(extractPrompt(u, false), {
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
curl -sS -X POST "$RELEASES_API_URL/v1/sources/${resolved.slug}/releases/batch" -H "Authorization: Bearer $RELEASES_API_KEY" -H "Content-Type: application/json" -d @chunk.json
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
  spentTokens,
};
const rep = await agent(
  `Write the maintenance run summary for this backfill.
Target file: ${RUN_DIR ? RUN_DIR + "/summary.md" : "<run dir from `releases admin work status --json`>/summary.md"}
Follow docs/architecture/maintenance-workspace.md's summary.md template (status, per-target counts table, cost, what changed, findings). Use these numbers VERBATIM (do not invent): ${JSON.stringify(summaryInputs)}.
Cost line, exactly: "${spentTokens} output tokens this turn (budget.spent()); session sub-agent tokens, no managed-agent bill." Stamp the date via \`date -u +%FT%TZ\`. Surface data-quality findings (empty content, thin pages, deferred-for-budget pages, write errors).
${WE_STARTED_RUN ? "Then run `releases admin work end` (this run started it)." : "Do NOT run `releases admin work end` — a parent sweep owns this run."}
Return the absolute report path.`,
  {
    label: "run-report",
    phase: "Report",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { reportPath: { type: "string" } },
      required: ["reportPath"],
    },
  },
);

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
  reportPath: (rep && rep.reportPath) || null,
};
