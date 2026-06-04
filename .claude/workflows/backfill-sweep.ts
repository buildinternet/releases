export const meta = {
  name: "backfill-sweep",
  description:
    "Sequential multi-source local backfill: runs the backfill-source workflow over a list under one maintenance run, then writes a cross-run pass-rate/cost report.",
  whenToUse:
    "Backfill several sources locally in one pass without the managed-agent bill. Dry-run first (the default). Launch via the backfilling-sources skill.",
  phases: [
    { title: "Sweep", detail: "sequential backfill-source per target" },
    { title: "Report", detail: "cross-run pass-rate/cost table" },
  ],
};

// ── Inlined deterministic helper ────────────────────────────────────────────
// MIRRORED VERBATIM from tests/workflows/backfill-helpers.js (Workflow scripts
// can't import). Unit-tested there; workflow-scripts.test.ts guards drift.
// Do not edit here without editing the module — the drift guard will fail.

function sweepReportPath(runDir) {
  if (!runDir) return null;
  const reportsDir = runDir.replace(/\/runs\/[^/]+$/, "/reports");
  const date = (runDir.split("/").pop() || "").slice(0, 10);
  return `${reportsDir}/${date}-backfill-sweep.md`;
}

let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    /* report below */
  }
}
input = input || {};
const SOURCES = Array.isArray(input.sources) ? input.sources : [];
if (input.maxReleases != null && !(Number.isInteger(input.maxReleases) && input.maxReleases > 0)) {
  log(`backfill-sweep: maxReleases must be a positive integer, got ${input.maxReleases}`);
  return { status: "error", error: "invalid maxReleases" };
}
const MAX = input.maxReleases == null ? 50 : input.maxReleases;
const DRY = input.dryRun !== false; // default true
const MODEL = input.model === "haiku" ? "haiku" : "sonnet";
if (!SOURCES.length) {
  log("backfill-sweep: missing required `sources` array");
  return { status: "error", error: "no sources" };
}

// ── Phase: Sweep ─────────────────────────────────────────────────────────────
phase("Sweep");
// Own ONE isolated maintenance run and thread its dir to every nested backfill so
// siblings share it WITHOUT the shared global `.current-run` pointer (#1396). We
// do not `work start` — that pointer leaks across concurrent sessions; we mint a
// fresh timestamped dir directly (same layout as run-dir.ts, honoring
// RELEASES_DATA_DIR) and pass its absolute path down via `runDir`.
const runInfo = await agent(
  `Create an ISOLATED maintenance run dir for this backfill sweep. Do NOT run \`releases admin work start\` (it sets a shared pointer that leaks across sessions). Run exactly this, then return the absolute dir it prints:
\`\`\`
base="\${RELEASES_DATA_DIR:-\${RELEASED_DATA_DIR:-$HOME/.releases}}/work"
dir="$base/runs/$(date +%Y-%m-%d-%H%M)-backfill-sweep"
mkdir -p "$dir" "$base/tasks" "$base/reports"
echo "$dir"
\`\`\`
Return runDir = the absolute path printed (it must start with / and end in -backfill-sweep).`,
  {
    label: "sweep-run-setup",
    phase: "Sweep",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { runDir: { type: "string" } },
      required: ["runDir"],
    },
  },
);
const RUN_DIR =
  runInfo && typeof runInfo.runDir === "string" && runInfo.runDir.startsWith("/")
    ? runInfo.runDir
    : null;
if (!RUN_DIR)
  log("sweep-run-setup: could not create an isolated run dir — per-source runs self-isolate");

const results = [];
for (const source of SOURCES) {
  log(`sweep: backfilling ${source}${DRY ? " (dry-run)" : ""}`);
  let r;
  try {
    // Pass the sweep's run dir so each source logs/reports into it (RUN_DIR null →
    // child mints its own isolated run; still pointer-free, just not co-located).
    r = await workflow("backfill-source", {
      source,
      maxReleases: MAX,
      dryRun: DRY,
      model: MODEL,
      runDir: RUN_DIR || undefined,
    });
  } catch (e) {
    r = { status: "error", source, error: String((e && e.message) || e) };
  }
  results.push(r || { status: "error", source, error: "null result" });
}

// ── Phase: Report ────────────────────────────────────────────────────────────
phase("Report");
// partial-budget is a resumable cost-gate stop, not a failure — count it as a success.
const SUCCESS = new Set(["completed", "dry-run", "partial-budget"]);
const ok = results.filter((r) => r && SUCCESS.has(r.status)).length;
const budgetStopped = results.filter((r) => r && r.status === "partial-budget").length;
const sweepStatus = ok === 0 ? "failed" : ok >= SOURCES.length ? "completed" : "partial";
// Deterministic cross-run report path, derived from the in-script run dir.
// No run dir → fall back to letting the agent stamp the date (best-effort).
const REPORT_PATH = sweepReportPath(RUN_DIR);
const reportDest = REPORT_PATH
  ? `this EXACT absolute path (already resolved — do not re-derive it): ${REPORT_PATH}`
  : "~/.releases/work/reports/<date>-backfill-sweep.md (stamp <date> via `date -u +%F`)";
const rep = await agent(
  `Write a cross-run sweep report to ${reportDest} using docs/architecture/maintenance-workspace.md's report template (pass-rate + cost table + findings).
${budgetStopped} source(s) stopped on the budget gate (status "partial-budget") — call these out as resumable, not failed.
Per-source results (use verbatim): ${JSON.stringify(results)}.
${REPORT_PATH ? `Self-verify it landed: \`test -f "${REPORT_PATH}" && echo EXISTS || echo MISSING\`; if MISSING, write it again. ` : ""}Do NOT run \`releases admin work end\` — this sweep does not use the shared run pointer. Return the absolute report path.`,
  {
    label: "sweep-report",
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
  status: sweepStatus,
  sources: SOURCES.length,
  succeeded: ok,
  budgetStopped,
  runDir: RUN_DIR,
  reportPath: REPORT_PATH || (rep && rep.reportPath) || null,
  results,
};
