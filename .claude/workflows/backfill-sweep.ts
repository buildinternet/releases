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
const MAX = Number.isFinite(input.maxReleases) ? input.maxReleases : 50;
const DRY = input.dryRun !== false; // default true
const MODEL = input.model === "haiku" ? "haiku" : "sonnet";
if (!SOURCES.length) {
  log("backfill-sweep: missing required `sources` array");
  return { status: "error", error: "no sources" };
}

// ── Phase: Sweep ─────────────────────────────────────────────────────────────
phase("Sweep");
// Own one maintenance run so each nested per-source run reuses it (no .current-run collisions).
await agent(
  `Start a maintenance run for this sweep: \`releases admin work start backfill-sweep --json\` and \`mkdir -p ~/.releases/work/tasks ~/.releases/work/reports\`. Return { ok: true }.`,
  {
    label: "sweep-run-start",
    phase: "Sweep",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
);

const results = [];
for (const source of SOURCES) {
  log(`sweep: backfilling ${source}${DRY ? " (dry-run)" : ""}`);
  let r;
  try {
    r = await workflow("backfill-source", { source, maxReleases: MAX, dryRun: DRY, model: MODEL });
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
const rep = await agent(
  `Write a cross-run sweep report to ~/.releases/work/reports/<date>-backfill-sweep.md using docs/architecture/maintenance-workspace.md's report template (pass-rate + cost table + findings). Stamp <date> via \`date -u +%F\`.
${budgetStopped} source(s) stopped on the budget gate (status "partial-budget") — call these out as resumable, not failed.
Per-source results (use verbatim): ${JSON.stringify(results)}.
Then run \`releases admin work end\` to close the sweep's run. Return the absolute report path.`,
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
  reportPath: (rep && rep.reportPath) || null,
  results,
};
