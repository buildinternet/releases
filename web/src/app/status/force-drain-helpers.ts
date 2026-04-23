/**
 * Pure helpers for the /status force-drain tile. Parses the `notes` field
 * force-drain-sweep writes to `cron_runs` (see
 * `workers/api/src/cron/force-drain-sweep.ts`). Kept separate from the React
 * component so the parsing logic is unit-testable without pulling in JSX.
 */

export type ForceDrainTone = "healthy" | "stranded" | "never" | "failed";

export type ForceDrainSummary = {
  stranded: number;
  tone: ForceDrainTone;
  /** Short user-visible string, e.g. "0 stranded · 6h ago" or "never run". */
  label: string;
};

const STRANDED_RE = /stranded_total=(\d+)/;

/**
 * `no stale/unreliable sources` → 0
 * `forced=3 (...) stranded_total=7` → 7
 * anything else unparseable → 0 (treat as healthy rather than invent a count)
 */
export function parseStrandedTotal(notes: string | null | undefined): number {
  if (!notes) return 0;
  const m = notes.match(STRANDED_RE);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
 */
export function summarizeForceDrain(
  run: { startedAt: string; status: string; notes: string | null } | null,
  now: number = Date.now(),
): ForceDrainSummary {
  if (!run) {
    return { stranded: 0, tone: "never", label: "never run" };
  }
  // force-drain-sweep doesn't have an abort path today, but be defensive —
  // a future preflight or thrown error shouldn't be silently reported as green.
  if (run.status !== "done") {
    return {
      stranded: 0,
      tone: "failed",
      label: `last run failed (${formatForceDrainAge(run.startedAt, now)})`,
    };
  }
  const stranded = parseStrandedTotal(run.notes);
  const age = formatForceDrainAge(run.startedAt, now);
  return {
    stranded,
    tone: stranded > 0 ? "stranded" : "healthy",
    label: `${stranded} stranded · ${age}`,
  };
}
