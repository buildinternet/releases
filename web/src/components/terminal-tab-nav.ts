/**
 * Resolves the next active-tab index for a `keydown` on a tablist, following
 * the WAI-ARIA tabs pattern: Left/Right move with horizontal wraparound,
 * Home/End jump to the ends. Returns `null` for any non-navigation key (and
 * for an empty tablist) so the caller can ignore the event.
 */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
