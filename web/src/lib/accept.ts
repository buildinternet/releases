/**
 * HTTP Accept header parsing and content negotiation per RFC 9110 §12.5.1.
 *
 * Returns the best matching offered media type based on q-value and
 * specificity, or `null` when no offered type is acceptable (caller should
 * reply with 406).
 */

export type MediaRange = {
  type: string;
  subtype: string;
  q: number;
  specificity: 1 | 2 | 3; // 1 = */*, 2 = type/*, 3 = type/subtype
  order: number;
};

export function parseAccept(header: string | null): MediaRange[] {
  if (!header || !header.trim()) {
    return [{ type: "*", subtype: "*", q: 1, specificity: 1, order: 0 }];
  }
  const ranges: MediaRange[] = [];
  let order = 0;
  for (const raw of header.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const segments = part.split(";").map((s) => s.trim());
    const media = segments[0];
    const slash = media.indexOf("/");
    if (slash <= 0 || slash === media.length - 1) continue;
    const type = media.slice(0, slash).toLowerCase();
    const subtype = media.slice(slash + 1).toLowerCase();
    if (type === "*" && subtype !== "*") continue;
    let q = 1;
    for (let i = 1; i < segments.length; i++) {
      const param = segments[i];
      const eq = param.indexOf("=");
      if (eq === -1) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      if (key !== "q") continue;
      const value = param
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        q = Math.max(0, Math.min(1, parsed));
      }
    }
    const specificity: 1 | 2 | 3 = type === "*" && subtype === "*" ? 1 : subtype === "*" ? 2 : 3;
    ranges.push({ type, subtype, q, specificity, order: order++ });
  }
  return ranges;
}

function rangeMatches(range: MediaRange, type: string, subtype: string): boolean {
  if (range.type === "*" && range.subtype === "*") return true;
  if (range.type === type && range.subtype === "*") return true;
  return range.type === type && range.subtype === subtype;
}

function bestRangeFor(ranges: MediaRange[], mediaType: string): MediaRange | null {
  const slash = mediaType.indexOf("/");
  const type = mediaType.slice(0, slash).toLowerCase();
  const subtype = mediaType.slice(slash + 1).toLowerCase();
  let best: MediaRange | null = null;
  for (const range of ranges) {
    if (!rangeMatches(range, type, subtype)) continue;
    if (
      !best ||
      range.specificity > best.specificity ||
      (range.specificity === best.specificity && range.q > best.q)
    ) {
      best = range;
    }
  }
  return best;
}

/**
 * Pick the best offered media type for the given Accept header.
 * Returns `null` when no offered type has a matching range with q > 0
 * — in which case the caller should respond 406 Not Acceptable.
 */
export function negotiate<T extends string>(
  accept: string | null,
  offered: readonly T[],
): T | null {
  const ranges = parseAccept(accept);
  let winner: { type: T; q: number; specificity: number; order: number } | null = null;
  for (let i = 0; i < offered.length; i++) {
    const mediaType = offered[i];
    const match = bestRangeFor(ranges, mediaType);
    if (!match || match.q === 0) continue;
    if (!winner || match.q > winner.q || (match.q === winner.q && i < winner.order)) {
      winner = { type: mediaType, q: match.q, specificity: match.specificity, order: i };
    }
  }
  return winner?.type ?? null;
}
