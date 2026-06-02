/**
 * Compact star-count formatting, GitHub-style: 1234 -> "1.2k", 1_500_000 -> "1.5M".
 * Counts under 1,000 are shown verbatim. One decimal below 100 of each unit,
 * whole numbers at/above 100 to keep the chip narrow.
 */
export function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const compact = (value: number, suffix: string): string => {
    const fixed = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
    return `${fixed}${suffix}`;
  };
  if (count < 1_000_000) return compact(count / 1000, "k");
  return compact(count / 1_000_000, "M");
}
