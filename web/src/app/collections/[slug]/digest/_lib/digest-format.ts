export function weekOfLabel(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00Z`);
  return `Week of ${start.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}
