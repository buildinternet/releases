// @ts-nocheck -- Workflow scripts run inside the runtime's injected-hook scope (agent, parallel,
// log, phase, budget, args are globals) and live outside any tsconfig, so an editor would report
// false implicit-any / undeclared-global errors. The runtime executes this; the pure helpers are
// type-clean in tests/workflows/overview-helpers.js and parse-guarded by workflow-scripts.test.ts.
export const meta = {
  name: "update-overviews",
  description:
    "Local batch overview regeneration: select orgs (outdated / overview-age window / activity window / explicit list), fetch only the lagging ones, generate via budget-gated agent() waves, lint + re-derive citation offsets in-parent, and upsert through `overview update` — no metered Anthropic bill.",
  whenToUse:
    "Refresh org overviews across a set of orgs locally without the server-side batch-overview Anthropic bill. Dry-run first (the default). Launch via the maintaining-orgs skill → Sweep via Workflow.",
  phases: [
    { title: "Select", detail: "overview plan manifest → mode filter → cap" },
    { title: "Fetch", detail: "serial source fetch for needsFetch orgs (skipped on dry-run)" },
    { title: "Generate", detail: "agent-per-org body + citations (budget-gated waves)" },
    { title: "Write", detail: "de-escape + lint + re-derive offsets + overview update" },
    { title: "Report", detail: "run summary to ~/.releases/work" },
  ],
};

// ── Tunables ──────────────────────────────────────────────────────────────
// Overview generation is heavy per org (~40–80K tokens), so waves are small and
// the reserve is sized so a budget stop overshoots by at most one wave.
const GEN_WAVE = 3; // orgs generated concurrently per budget-checked wave
const PER_WAVE_RESERVE = 250000; // stop scheduling a new wave when budget.remaining() drops below this
const MAX_CONTENT_CHARS = 1000; // clip each release body client-side (silent-truncation guard)

// ── Inlined deterministic helpers ──────────────────────────────────────────
// MIRRORED VERBATIM from tests/workflows/overview-helpers.js (Workflow scripts
// can't import). Unit-tested there; workflow-scripts.test.ts guards drift.
// Do not edit here without editing the module — the drift guard will fail.

function inferSelectionMode(input) {
  const a = input || {};
  if (Array.isArray(a.orgs) && a.orgs.length > 0) return "orgs";
  if (a.activeSince != null || a.activeUntil != null) return "activity";
  if (a.overviewUpdatedFrom != null || a.overviewUpdatedTo != null) return "overviewAge";
  return "outdated";
}

function filterByDateWindow(rows, field, from, to) {
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

function unescapeHtmlEntities(s) {
  if (typeof s !== "string") return s;
  const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => map[m]);
}

function lintOverviewBody(body, orgName) {
  const text = typeof body === "string" ? body : "";
  const violations = [];
  if (/^#{1,6}\s/m.test(text)) violations.push("markdown-heading");
  const trimmed = text.trim();
  const sm = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const opener = (sm ? sm[0] : trimmed.split("\n")[0] || "").trim();
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

function deriveCitationOffsets(body, citations) {
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

function budgetGate(total, remaining, reserve, done, totalTargets) {
  if (!total) return { stop: false };
  if (remaining >= reserve) return { stop: false };
  const deferred = totalTargets - done;
  return {
    stop: true,
    logLine: `budget gate: ${remaining} tokens left (< ${reserve} reserve); stopping at ${done}/${totalTargets}, ${deferred} orgs deferred — re-run to continue (idempotent)`,
  };
}

// ── Schemas (forced structured output) ──────────────────────────────────────
const SELECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          orgSlug: { type: "string" },
          overviewUpdatedAt: { type: ["string", "null"] },
          orgLastActivity: { type: ["string", "null"] },
          releasesSinceOverview: { type: ["number", "null"] },
          staleness: { type: ["string", "null"] },
          needsFetch: { type: ["boolean", "null"] },
        },
        required: ["orgSlug"],
      },
    },
  },
  required: ["rows"],
};
const FETCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean" }, error: { type: ["string", "null"] } },
  required: ["ok"],
};
const GEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["generated", "empty-window", "error"] },
    body: { type: ["string", "null"] },
    orgName: { type: ["string", "null"] },
    citations: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sourceUrl: { type: "string" },
          title: { type: ["string", "null"] },
          citedText: { type: "string" },
        },
        required: ["sourceUrl", "citedText"],
      },
    },
    releaseCount: { type: ["number", "null"] },
    lastContributingAt: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
  },
  required: ["status"],
};
const WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    written: { type: "boolean" },
    citationCount: { type: ["number", "null"] },
    error: { type: ["string", "null"] },
  },
  required: ["written"],
};

// ── Local prompt helpers (not shared; fine to keep here) ─────────────────────

// Count the words in the body's opening sentence, using the SAME extraction
// lintOverviewBody applies (first sentence-final punctuation, else first line;
// markdown emphasis stripped). Lets the corrective pass tell the model exactly
// how far over the 25-word opener cap it was, which is far more actionable than
// the bare "opener-too-long" code — the most common residual violation.
function openerWordCount(body) {
  const text = typeof body === "string" ? body : "";
  const trimmed = text.trim();
  const sm = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const opener = (sm ? sm[0] : trimmed.split("\n")[0] || "").trim();
  return opener.replace(/[*`_]/g, "").split(/\s+/).filter(Boolean).length;
}

// Turn raw violation codes into the corrective hints the regen prompt echoes.
// Only opener-too-long is enriched (with the measured word count); everything
// else passes through verbatim.
function correctiveHints(violations, body) {
  return (violations || []).map((v) =>
    v === "opener-too-long"
      ? `opener-too-long (your opening sentence was ${openerWordCount(body)} words — rewrite it to 25 words or fewer)`
      : v,
  );
}

function genPrompt(slug, corrective) {
  const fix =
    corrective && corrective.length
      ? `\nYOUR PREVIOUS DRAFT FAILED THESE LINT RULES — fix them and regenerate: ${corrective.join(", ")}.\n`
      : "";
  return `Regenerate the AI overview for the "${slug}" org in the Releases registry. The \`releases\` CLI is installed and authenticated against production. Do NOT fetch and do NOT upload — generate only and return the result inline. Read the regenerating-overviews skill for the full prompt; the rules below are the load-bearing subset.
${fix}
1. Read inputs with each release body clipped (the raw payload truncates silently otherwise):
     releases admin overview inputs ${slug} --json --max-content-chars ${MAX_CONTENT_CHARS}
   If \`selected\` is empty, return { status: "empty-window" }. If the read looks truncated (ends mid-JSON, or \`selected\` count is far below \`totalAvailable\`), return { status: "error", note: "truncated read" }.
2. Generate the markdown body from \`selected\` (HARD rules — linted in-parent):
   - Do NOT open with the org's own name as the sentence subject. Bad: "${slug} shipped…", "${slug}'s SDK…". Good: "Recently shipped X" or a product name ("Nuxt Agent launched…"). Product names containing the org name are fine.
   - Opening sentence ≤25 words.
   - Bold-tease section headers describe the user-facing claim, NOT a version or CVE id. Bad: "**3.2.0 added X**", "**CVE-2024-… patched**". Good: "**Persistent state landed**".
   - No editorializing: ban biggest, doubling down, leap forward, powerful, seamless, comprehensive, world-class, best-in-class, transformative, next-generation, cutting-edge.
   - No markdown headings (#, ##, …). No admissions of ingestion gaps.
   - 250 words target, 300 HARD ceiling, 80 floor. Past tense, active voice. When \`existingContent\` is present, amend and evolve it — don't rewrite from scratch.
3. Citations (model-asserted): for each major claim pick the backing release URL from \`selected[*].url\`. Return an array of { sourceUrl, title, citedText } where citedText is an EXACT, contiguous substring of your body from a SINGLE formatting run (never spanning ** markers). Do NOT compute offsets — the parent re-derives them.
Return { status: "generated", body, orgName: <org.name from inputs>, citations, releaseCount: <totalAvailable from inputs>, lastContributingAt: <selected[0].publishedAt> }.`;
}

function writePrompt(slug, body, citations, releaseCount, lastContributingAt, runEnv) {
  const extra = [
    Number.isFinite(releaseCount) ? `--release-count ${releaseCount}` : "",
    lastContributingAt ? `--last-contributing-at ${lastContributingAt}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `Upload a regenerated overview for the "${slug}" org. Steps, in order:
1. Write the decoded value of BODY_JSON (it is a JSON-encoded string — write its contents, not the surrounding quotes) to a temp file, e.g. /tmp/${slug}-overview.md.
2. Write CITATIONS_JSON verbatim (a JSON array) to /tmp/${slug}-overview-citations.json.
3. Run this command EXACTLY${runEnv ? ", including the leading `RELEASES_RUN_DIR=…` env prefix (it pins this mutation to the workflow's own isolated run — without it the write logs to whatever `.current-run` happens to point at, which is the cross-session leak this guards against)" : ""}: ${runEnv}releases admin overview update ${slug} --content-file /tmp/${slug}-overview.md --citations-file /tmp/${slug}-overview-citations.json ${extra}
   Do NOT pass --unescape-html (the body is already decoded and offsets are computed against it).
4. Report written=true if it exited 0, the accepted citation count from the response ("citations": N) as citationCount, and any non-2xx error.
BODY_JSON: ${JSON.stringify(body)}
CITATIONS_JSON: ${JSON.stringify(citations)}`;
}

// Decode the five over-escaped HTML entities and strip a trailing newline so the
// stored body and the offsets computed against it line up. Applied identically to
// the initial draft and the corrective pass.
function decodeBody(raw) {
  return unescapeHtmlEntities(typeof raw === "string" ? raw : "").replace(/\s+$/, "");
}

// Decode each model-asserted citation's citedText so it matches the decoded body
// before deriveCitationOffsets locates it.
function decodeCitations(gen) {
  return Array.isArray(gen.citations)
    ? gen.citations.map((c) => ({ ...c, citedText: unescapeHtmlEntities(c.citedText) }))
    : [];
}

// Render the run-summary markdown deterministically in-script so the report
// agent's only job is a verbatim file write — not formatting numbers from a
// template, which is what failed to land (reportWritten:false) in past sweeps.
// The date/time comes from the run-dir basename (Date.now() is unavailable in
// workflow scripts), which already encodes <YYYY-MM-DD-HHMM>.
function renderSummaryMarkdown(inputs, runDir, status) {
  const m = String(runDir || "").match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})-update-overviews\/?$/);
  const when = m ? `${m[1]} ${m[2]}:${m[3]} (run-local)` : "(date unknown)";
  const lint = inputs.lintFlagged || [];
  const fetchErrors = inputs.fetchErrors || [];
  const stripped = inputs.citationsStripped || [];
  const lintLine = lint.length
    ? lint.map((r) => `${r.slug} (${(r.violations || []).join(", ")})`).join(", ")
    : "none";
  return [
    "# Overview sweep — update-overviews",
    "",
    `**Status:** ${status}`,
    `**Date:** ${when}`,
    `**Mode:** ${inputs.mode} · fetch=${inputs.fetchPlan}`,
    "",
    "## Result",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Candidates | ${inputs.candidates} |`,
    `| Targets | ${inputs.targets} (cappedOut ${inputs.cappedOut}) |`,
    `| Generated + written | ${inputs.generated} |`,
    `| Empty-window skips | ${inputs.emptyWindow} |`,
    `| Fetch errors | ${fetchErrors.length} |`,
    `| Lint-flagged (uploaded anyway) | ${lint.length} |`,
    `| Prior citations stripped to zero | ${stripped.length} |`,
    `| Deferred for budget | ${inputs.deferredForBudget} |`,
    "",
    "## Cost",
    "",
    `${inputs.spentTokens} output tokens this turn (budget.spent(), excludes this summary write); session sub-agent tokens, no managed-agent bill — except any needsFetch source fetches.`,
    "",
    "## Findings",
    "",
    `- **Lint-flagged, review recommended:** ${lintLine}. Uploaded as-is; the single corrective regen pass did not bring them clean.`,
    `- **Empty-window skips:** ${inputs.emptyWindow} (no-ops — nothing to say in the window).`,
    `- **Fetch errors:** ${fetchErrors.length ? fetchErrors.join(", ") + " (regen correctly skipped — never regenerated on stale data)" : "none"}.`,
    `- **Prior citations stripped to zero:** ${stripped.length ? stripped.join(", ") : "none"}.`,
    "",
  ].join("\n");
}

async function regenOneOrg(t) {
  const slug = t.slug;
  let gen = await agent(genPrompt(slug, null), {
    label: `gen:${slug}`,
    phase: "Generate",
    model: GEN_MODEL,
    schema: GEN_SCHEMA,
  });
  if (!gen || gen.status === "error")
    return { slug, status: "gen-error", note: (gen && gen.note) || "no result" };
  if (gen.status === "empty-window") return { slug, status: "empty-window" };
  let body = decodeBody(gen.body);
  if (!body) return { slug, status: "gen-error", note: "empty body" };
  const orgName = gen.orgName || slug;
  let rawCitations = decodeCitations(gen);
  let violations = lintOverviewBody(body, orgName);

  if (violations.length) {
    const gen2 = await agent(genPrompt(slug, correctiveHints(violations, body)), {
      label: `gen-fix:${slug}`,
      phase: "Generate",
      model: GEN_MODEL,
      schema: GEN_SCHEMA,
    });
    if (gen2 && gen2.status === "generated" && typeof gen2.body === "string" && gen2.body.trim()) {
      const body2 = decodeBody(gen2.body);
      const v2 = lintOverviewBody(body2, gen2.orgName || orgName);
      if (v2.length <= violations.length) {
        body = body2;
        rawCitations = decodeCitations(gen2);
        violations = v2;
        gen = gen2;
      }
    }
  }

  const { citations, dropped } = deriveCitationOffsets(body, rawCitations);
  const wr = await agent(
    writePrompt(slug, body, citations, gen.releaseCount, gen.lastContributingAt, runEnv),
    { label: `write:${slug}`, phase: "Write", model: "haiku", schema: WRITE_SCHEMA },
  );
  const written = !!(wr && wr.written);
  return {
    slug,
    status: written ? "written" : "write-error",
    chars: body.length,
    citationsAccepted: citations.length,
    citationsDropped: dropped,
    citationCountConfirmed: (wr && wr.citationCount) ?? null,
    violations,
    hadOverview: !!t.hasOverview,
    writeError: (wr && wr.error) || null,
  };
}

// ── args ─────────────────────────────────────────────────────────────────────
let input = args;
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch {
    /* validated below */
  }
}
input = input || {};
const ORGS = Array.isArray(input.orgs)
  ? input.orgs
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .filter((s) => {
        // Keep only plausible slugs so whitespace / shell-unsafe characters can't
        // reach the fetch/update command strings or the /tmp paths built from them.
        if (/^[A-Za-z0-9._-]+$/.test(s)) return true;
        log(
          `update-overviews: dropping org "${s}" — slugs allow letters, digits, dot, underscore, hyphen only`,
        );
        return false;
      })
  : [];
if (input.maxOrgs != null && !(Number.isInteger(input.maxOrgs) && input.maxOrgs > 0)) {
  log(`update-overviews: maxOrgs must be a positive integer, got ${input.maxOrgs}`);
  return { status: "error", error: "invalid maxOrgs" };
}
const MAX_ORGS = input.maxOrgs == null ? 25 : input.maxOrgs;
// Default 14 = the server's "behind" eligibility threshold (DEFAULT_MIN_OVERVIEW_AGE_DAYS)
// that `--stale-days` controls — not OVERVIEW_STALE_DAYS (30), the display-only staleness mark.
const STALE_DAYS =
  input.staleDays != null ? Math.max(0, Math.floor(Number(input.staleDays) || 0)) : 14;
const MISSING = input.missing !== false; // default true
const HAS_ACTIVITY = input.hasActivity !== false; // default true
const OVERVIEW_FROM = input.overviewUpdatedFrom ?? null;
const OVERVIEW_TO = input.overviewUpdatedTo ?? null;
const ACTIVE_SINCE = input.activeSince ?? null;
const ACTIVE_UNTIL = input.activeUntil ?? null;
const FETCH = input.fetch === "none" || input.fetch === "all" ? input.fetch : "needsFetch";
const DRY = input.dryRun !== false; // default true
const GEN_MODEL = input.model === "haiku" ? "haiku" : "sonnet";
const mode = inferSelectionMode(input);

// ── Phase: Select ──────────────────────────────────────────────────────────
phase("Select");
// `orgs` mode deliberately fetches the bare manifest (no --has-activity) — the
// caller named exact slugs and is the gate, so an inactive org they listed is
// still attempted (it will skip later as empty-window if there's nothing to say).
let planCmd = "releases admin overview plan --json";
if (mode === "outdated") {
  planCmd += ` --stale-days ${STALE_DAYS}`;
  if (MISSING) planCmd += " --missing";
  if (HAS_ACTIVITY) planCmd += " --has-activity";
} else if (mode === "overviewAge" || mode === "activity") {
  if (HAS_ACTIVITY) planCmd += " --has-activity";
}
const selectRes = await agent(
  `Fetch the overview-regen manifest for this sweep. Run exactly:
\`${planCmd}\`
The response is a JSON envelope \`{ items, pagination }\` listing curated orgs (on-demand orgs are already excluded) with freshness signals. Return EVERY item — if \`pagination.hasMore\` is true, page through with \`--page N\` until it isn't. Pass each item's fields through verbatim under these exact names: orgSlug, overviewUpdatedAt, orgLastActivity, releasesSinceOverview, staleness, needsFetch. Use null for any field an item omits.`,
  { label: "select-manifest", phase: "Select", model: "haiku", schema: SELECT_SCHEMA },
);
const rows = (selectRes && Array.isArray(selectRes.rows) ? selectRes.rows : []).filter(
  (r) => r && typeof r.orgSlug === "string" && r.orgSlug.trim(),
);

function toTarget(r) {
  return {
    slug: r.orgSlug,
    needsFetch: !!r.needsFetch,
    hasOverview: r.staleness ? r.staleness !== "missing" : r.overviewUpdatedAt != null,
    releasesSinceOverview: r.releasesSinceOverview ?? 0,
  };
}

let targets;
if (mode === "orgs") {
  const bySlug = new Map(rows.map((r) => [r.orgSlug.toLowerCase(), r]));
  targets = ORGS.map((slug) => {
    const r = bySlug.get(slug.toLowerCase());
    if (!r) return { slug, needsFetch: false, hasOverview: false, releasesSinceOverview: 0 };
    const t = toTarget(r);
    t.slug = slug; // preserve the caller's requested casing
    return t;
  });
} else if (mode === "overviewAge") {
  targets = filterByDateWindow(rows, "overviewUpdatedAt", OVERVIEW_FROM, OVERVIEW_TO).map(toTarget);
} else if (mode === "activity") {
  targets = filterByDateWindow(rows, "orgLastActivity", ACTIVE_SINCE, ACTIVE_UNTIL).map(toTarget);
} else {
  targets = rows.map(toTarget);
}

// Most-stale-first so a truncated run hits the highest-value orgs. Explicit-list
// order is preserved (callers chose it deliberately).
if (mode !== "orgs")
  targets.sort((a, b) => (b.releasesSinceOverview || 0) - (a.releasesSinceOverview || 0));
const candidates = targets.length;
const capped = targets.slice(0, MAX_ORGS);
const cappedOut = candidates - capped.length;
const needsFetchCount = capped.filter((t) => t.needsFetch).length;
log(
  `select: mode=${mode}, candidates=${candidates}, targets=${capped.length}, cappedOut=${cappedOut}, needsFetch=${needsFetchCount}`,
);

if (DRY) {
  return {
    status: "dry-run",
    mode,
    candidates,
    targets: capped.length,
    cappedOut,
    needsFetch: needsFetchCount,
    fetchPlan: FETCH,
    sampleSlugs: capped.slice(0, 10).map((t) => t.slug),
    note: "Re-invoke with dryRun:false to fetch + generate + write. Set a turn budget (+Nk) to cap generation spend.",
  };
}
if (!capped.length) {
  log("no target orgs after selection — nothing to regenerate");
  return { status: "completed", mode, candidates, targets: 0, written: 0 };
}

// Own an ISOLATED maintenance run so each `overview update` auto-logs into THIS
// sweep's dir and nowhere else. We deliberately do NOT `work start` — that writes
// the shared global `.current-run` pointer, and any concurrent `releases admin`
// write in another session resolves that pointer and leaks into our run (#1396).
// Instead we mint a fresh timestamped run dir directly (same layout/naming as the
// CLI's startRun → run-dir.ts: `<dataDir>/work/runs/<YYYY-MM-DD-HHMM>-<batch>`,
// honoring RELEASES_DATA_DIR) without touching the pointer, then pin every write
// to it with an inline `RELEASES_RUN_DIR=…` prefix (resolveRunDir: env wins over
// the pointer, and inline survives the fresh-shell-per-Bash-call harness).
const runInfo = await agent(
  `Create an ISOLATED maintenance run dir for this overview sweep. Do NOT run \`releases admin work start\` (it sets a shared pointer that leaks across sessions). Run exactly this, then return the absolute dir it prints:
\`\`\`
base="\${RELEASES_DATA_DIR:-\${RELEASED_DATA_DIR:-$HOME/.releases}}/work"
dir="$base/runs/$(date +%Y-%m-%d-%H%M)-update-overviews"
mkdir -p "$dir" "$base/tasks" "$base/reports"
echo "$dir"
\`\`\`
Return runDir = the absolute path printed (it must start with / and end in -update-overviews).`,
  {
    label: "run-setup",
    phase: "Select",
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
// Inline env prefix that pins a CLI mutation to RUN_DIR regardless of `.current-run`.
// Empty when run-setup failed — the mutation still runs, just unlogged (degraded, not fatal).
const runEnv = RUN_DIR ? `RELEASES_RUN_DIR="${RUN_DIR}" ` : "";
if (!RUN_DIR)
  log("run-setup: could not create an isolated run dir — mutations this sweep go unlogged");

// ── Phase: Fetch ───────────────────────────────────────────────────────────
const fetchFailed = new Set();
if (FETCH !== "none") {
  phase("Fetch");
  // Serial — concurrent managed-agent fetches 409.
  const toFetch = FETCH === "all" ? capped : capped.filter((t) => t.needsFetch);
  for (const t of toFetch) {
    // eslint-disable-next-line no-await-in-loop -- serial by design: concurrent managed-agent fetches return 409
    const fr = await agent(
      `Fetch all active sources for org "${t.slug}" so its overview reflects the latest releases. Run this command EXACTLY${runEnv ? ", keeping the leading `RELEASES_RUN_DIR=…` prefix that pins the fetch to this sweep's isolated run" : ""}: \`${runEnv}releases admin source fetch --org ${t.slug} --wait\`. Report ok=true only if it exited 0; otherwise ok=false with a one-line error. Do NOT regenerate anything.`,
      { label: `fetch:${t.slug}`, phase: "Fetch", model: "haiku", schema: FETCH_SCHEMA },
    );
    if (!fr || fr.ok === false) {
      fetchFailed.add(t.slug);
      log(`fetch: ${t.slug} failed — skipping its regen (won't regen on stale data)`);
    }
  }
}

// ── Phase: Generate (+ in-script Write) ──────────────────────────────────────
phase("Generate");
const toGen = capped.filter((t) => !fetchFailed.has(t.slug));
const results = [];
let done = 0;
let deferredForBudget = 0;
for (let i = 0; i < toGen.length; i += GEN_WAVE) {
  const gate = budgetGate(budget.total, budget.remaining(), PER_WAVE_RESERVE, done, toGen.length);
  if (gate.stop) {
    log(gate.logLine);
    deferredForBudget = toGen.length - done;
    break;
  }
  const wave = toGen.slice(i, i + GEN_WAVE);
  // eslint-disable-next-line no-await-in-loop -- sequential by design: the budget gate must settle between waves
  const waveResults = await parallel(wave.map((t) => () => regenOneOrg(t)));
  for (const r of waveResults) if (r) results.push(r);
  done += wave.length;
}

// ── Phase: Report ────────────────────────────────────────────────────────────
phase("Report");
const written = results.filter((r) => r.status === "written").length;
const emptyWindow = results.filter((r) => r.status === "empty-window").length;
const genErrors = results.filter((r) => r.status === "gen-error" || r.status === "write-error");
const fetchErrorSlugs = [...fetchFailed];
const lintFlagged = results.filter((r) => r.violations && r.violations.length);
const citationsStripped = results.filter(
  (r) => r.status === "written" && r.hadOverview && r.citationsAccepted === 0,
);
const status = deferredForBudget > 0 ? "partial-budget" : "completed";
const spentTokens = Math.round(budget.spent());
const summaryInputs = {
  mode,
  candidates,
  targets: capped.length,
  cappedOut,
  fetchPlan: FETCH,
  fetchErrors: fetchErrorSlugs,
  generated: written,
  emptyWindow,
  deferredForBudget,
  lintFlagged: lintFlagged.map((r) => ({ slug: r.slug, violations: r.violations })),
  citationsStripped: citationsStripped.map((r) => r.slug),
  spentTokens,
  results,
};
// Deterministic report path: computed in-script, not re-resolved by the agent from
// the (racy) active-run pointer. When run-setup failed there's nowhere to write —
// skip the report rather than have the agent guess a dir.
const SUMMARY_PATH = RUN_DIR ? RUN_DIR + "/summary.md" : null;
let rep = null;
if (!SUMMARY_PATH) {
  log("report: no isolated run dir — skipping summary.md (sweep results are in the return value)");
} else {
  const summaryMd = renderSummaryMarkdown(summaryInputs, RUN_DIR, status);
  rep = await agent(
    `Write the overview-sweep run summary to this EXACT absolute path: ${SUMMARY_PATH}

The file content is already rendered below as SUMMARY_MD — write it byte-for-byte. Do NOT reformat it, summarize it, recompute any numbers, or add anything. Steps IN ORDER:
1. Write SUMMARY_MD verbatim to ${SUMMARY_PATH}.
2. Self-verify it landed: run \`test -f "${SUMMARY_PATH}" && echo EXISTS || echo MISSING\`. If MISSING, write it again and re-check. Only set wrote=true once the check prints EXISTS.
3. Do NOT run \`releases admin work end\` — this workflow does not use the shared run pointer.
4. Return reportPath=${SUMMARY_PATH} and wrote = whether the test -f check printed EXISTS.

SUMMARY_MD:
${summaryMd}`,
    {
      label: "run-report",
      phase: "Report",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { reportPath: { type: "string" }, wrote: { type: "boolean" } },
        required: ["reportPath", "wrote"],
      },
    },
  );
  if (!rep || !rep.wrote) {
    log(
      `WARNING: run-report agent did not confirm summary.md landed at ${SUMMARY_PATH} (wrote=${rep?.wrote}). Write it by hand from the return value.`,
    );
  }
}

return {
  status,
  mode,
  candidates,
  targets: capped.length,
  cappedOut,
  fetchErrors: fetchErrorSlugs,
  generated: written,
  emptyWindow,
  genErrors: genErrors.map((r) => ({
    slug: r.slug,
    status: r.status,
    note: r.note || r.writeError,
  })),
  // Surface the flagged slugs + their violations, not just a count, so the
  // operator can act on them without digging the run transcript. Same shape as
  // the summaryInputs entry the report agent receives.
  lintFlagged: lintFlagged.map((r) => ({ slug: r.slug, violations: r.violations })),
  citationsStripped: citationsStripped.map((r) => r.slug),
  deferredForBudget,
  actualCostTokens: spentTokens,
  runDir: RUN_DIR,
  reportPath: SUMMARY_PATH,
  reportWritten: !!(rep && rep.wrote),
};
