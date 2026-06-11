// Pure window math for the daily draft. `today`/`latest` are ISO dates (UTC).
export interface DraftWindow {
  sinceIso: string;
  untilIso: string;
  cappedFrom: string | null; // original since if the span was clamped, else null
}

const DAY_MS = 86_400_000;

export function addDays(dateIso: string, n: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function computeDraftWindow(
  latestSectionIso: string | null,
  todayIso: string,
  maxSpanDays = 7,
): DraftWindow {
  const untilIso = addDays(todayIso, -1); // yesterday
  let sinceIso = latestSectionIso ? addDays(latestSectionIso, 1) : untilIso;
  let cappedFrom: string | null = null;
  const spanDays = Math.round((Date.parse(untilIso) - Date.parse(sinceIso)) / DAY_MS);
  if (spanDays > maxSpanDays) {
    cappedFrom = sinceIso;
    sinceIso = addDays(untilIso, -maxSpanDays);
  }
  return { sinceIso, untilIso, cappedFrom };
}
