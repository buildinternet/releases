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
  // Cut over to "M" at 999,500 so the 999.5k–999.9k window rounds to "1M"
  // instead of the odd "1000k".
  if (count < 999_500) return compact(count / 1000, "k");
  return compact(count / 1_000_000, "M");
}
