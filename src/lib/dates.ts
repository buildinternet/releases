export function elapsedSec(startTime: number): string {
  return ((performance.now() - startTime) / 1000).toFixed(1);
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
