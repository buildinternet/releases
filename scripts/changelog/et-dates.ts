// America/New_York calendar-day helpers for the changelog day brackets.
// The changelog brackets days by Eastern Time (where the team works), so an
// evening merge lands in the day it was actually shipped, not the next UTC day.
const ET_ZONE = "America/New_York";

const stampFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: ET_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function etStamp(ms: number): { day: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of stampFmt.formatToParts(ms)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// The Eastern calendar date ("YYYY-MM-DD") a UTC instant falls on.
export function etDayOf(instant: number | Date): string {
  return etStamp(typeof instant === "number" ? instant : instant.getTime()).day;
}

// The UTC instant of midnight in America/New_York on the given date, as a
// second-precision ISO string. ET is UTC-4 (EDT) or UTC-5 (EST); DST changes
// at 2am local, so midnight always exists exactly once — probe both offsets.
export function etMidnightUtc(dateIso: string): string {
  for (const offset of ["-04:00", "-05:00"]) {
    const ms = Date.parse(`${dateIso}T00:00:00${offset}`);
    const s = etStamp(ms);
    if (s.day === dateIso && s.time === "00:00") {
      return new Date(ms).toISOString().slice(0, 19) + "Z";
    }
  }
  throw new Error(`Could not resolve ET midnight for ${dateIso}`);
}
