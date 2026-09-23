// Tier thresholds — must stay in sync with workers/api/src/cron/retier.ts.
const CADENCE_NORMAL_MAX = 14;
const CADENCE_LOW_MAX = 90;

export function describeCadence(
  medianGapDays: number | null | undefined,
  fetchPriority: string | null | undefined,
  lastRetieredAt: string | null | undefined,
  now: Date = new Date(),
): { primary: string; secondary: string; tone: "normal" | "warn"; tooltip: string } {
  if (medianGapDays == null) {
    return {
      primary: "—",
      secondary: lastRetieredAt ? "<3 releases of signal" : "never retiered",
      tone: "normal",
      tooltip: "Retier needs ≥3 releases in the last 180d to classify cadence.",
    };
  }
  const primary = `${formatGap(medianGapDays)} median`;
  let implied: "normal" | "low" | null = null;
  if (medianGapDays <= CADENCE_NORMAL_MAX) implied = "normal";
  else if (medianGapDays <= CADENCE_LOW_MAX) implied = "low";
  // Mismatch if cadence implies a tier that differs from the current
  // fetchPriority. Most informative case: source paused but still shipping.
  const mismatched = implied && fetchPriority && implied !== fetchPriority;
  const tone: "normal" | "warn" = mismatched ? "warn" : "normal";
  const secondary = lastRetieredAt
    ? `retiered ${formatAgeAgo(new Date(lastRetieredAt), now)}`
    : "never retiered";
  const tooltip = mismatched
    ? `Cadence implies ${implied} tier but source is ${fetchPriority}. Retier next run may adjust.`
    : "Median gap over last 180d of published releases.";
  return { primary, secondary, tone, tooltip };
}

function formatGap(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

function formatAgeAgo(then: Date, now: Date): string {
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
