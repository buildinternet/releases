/**
 * Pure helpers for the /status force-drain tile. Parses the `notes` field
 * force-drain-sweep writes to `cron_runs` (see
 * `workers/api/src/cron/force-drain-sweep.ts`). Kept separate from the React
 * component so the parsing logic is unit-testable without pulling in JSX.
 */

export type ForceDrainTone = "healthy" | "stranded" | "never" | "failed";

export type ForceDrainSummary = {
  /** Candidates the cron found (matches the cron's `stranded_total`). */
  stranded: number;
  /** Of those, how many the cron flagged this run. */
  forced: number;
  /** stranded - forced. >0 means the per-run cap was hit, backlog is growing. */
  skipped: number;
  tone: ForceDrainTone;
  /** Short user-visible string, e.g. "drained 2 · 6h ago" or "never run". */
  label: string;
};

// Anchor the keys at word boundaries so substrings like "pre_forced=5" or
// "_stranded_total=2" can't satisfy the match by accident.
const STRANDED_RE = /\bstranded_total=(\d+)/;
const FORCED_RE = /\bforced=(\d+)/;

function parseNonNegativeInt(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * `no stale/unreliable sources` → 0
 * `forced=3 (...) stranded_total=7` → 7
 * anything else unparseable → 0 (treat as healthy rather than invent a count)
 */
export function parseStrandedTotal(notes: string | null | undefined): number {
  if (!notes) return 0;
  return parseNonNegativeInt(notes.match(STRANDED_RE)?.[1]);
}

/**
 * Pull both `forced` and `stranded_total` from the cron note. Lets the tile
 * distinguish "found 2, drained 2" (healthy — safety net did its job) from
 * "found 7, drained 3" (amber — per-run cap was hit, backlog growing).
 */
export function parseForceDrainCounts(notes: string | null | undefined): {
  forced: number;
  stranded: number;
} {
  if (!notes) return { forced: 0, stranded: 0 };
  return {
    forced: parseNonNegativeInt(notes.match(FORCED_RE)?.[1]),
    stranded: parseNonNegativeInt(notes.match(STRANDED_RE)?.[1]),
  };
}

/** Minutes/hours/days, matching the tile's terse style. */
export function formatForceDrainAge(startedAt: string, now: number = Date.now()): string {
  const t = new Date(startedAt).getTime();
  if (!Number.isFinite(t)) return "unknown";
  const ms = Math.max(0, now - t);
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Build a summary for the tile from the latest force-drain cron_runs row, or
 * lack thereof. Never throws — a missing/garbled row returns a sensible
 * fallback so the tile degrades gracefully when the flag is off or before the
 * first run lands.
 *
 * Tone is calibrated to the action-required signal:
 *   - `healthy`   → run succeeded; backlog cleared (`stranded == forced`).
 *                   Includes the common "found nothing" case.
 *   - `stranded`  → cap was hit, backlog is growing (`stranded > forced`).
 *                   This is the only "needs attention" case, so it's the only
 *                   one that should color the tile amber.
 *   - `failed`    → cron didn't reach `done` (defensive — no abort path today).
 *   - `never`     → no rows at all (flag never on / pre-rollout).
 */
export function summarizeForceDrain(
  run: { startedAt: string; status: string; notes: string | null } | null,
  now: number = Date.now(),
): ForceDrainSummary {
  if (!run) {
    return { stranded: 0, forced: 0, skipped: 0, tone: "never", label: "never run" };
  }
  // force-drain-sweep doesn't have an abort path today, but be defensive —
  // a future preflight or thrown error shouldn't be silently reported as green.
  if (run.status !== "done") {
    return {
      stranded: 0,
      forced: 0,
      skipped: 0,
      tone: "failed",
      label: `last run failed (${formatForceDrainAge(run.startedAt, now)})`,
    };
  }
  const { stranded, forced } = parseForceDrainCounts(run.notes);
  const skipped = Math.max(0, stranded - forced);
  const age = formatForceDrainAge(run.startedAt, now);
  if (stranded === 0) {
    return { stranded: 0, forced: 0, skipped: 0, tone: "healthy", label: `no stranded · ${age}` };
  }
  if (skipped === 0) {
    // Cron found candidates and drained all of them this pass — nothing to do.
    return {
      stranded,
      forced,
      skipped: 0,
      tone: "healthy",
      label: `drained ${forced} · ${age}`,
    };
  }
  return {
    stranded,
    forced,
    skipped,
    tone: "stranded",
    label: `${skipped} backlog · drained ${forced} · ${age}`,
  };
}
