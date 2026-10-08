/**
 * Squarified treemap (Bruls, Huizing & van Wijk) in a fixed virtual box.
 * Values are laid out in the order given — pass them sorted descending for
 * the squarest tiles. Zero or negative values get a zero-size rect.
 */

export const TREEMAP_WIDTH = 712;
export const TREEMAP_HEIGHT = 300;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function squarify(
  values: readonly number[],
  width = TREEMAP_WIDTH,
  height = TREEMAP_HEIGHT,
): Rect[] {
  const rects: Rect[] = values.map(() => ({ ...EMPTY }));
  const idx = values.map((_, i) => i).filter((i) => values[i] > 0);
  const total = idx.reduce((sum, i) => sum + values[i], 0);
  if (total === 0) return rects;

  const area = values.map((v) => (v > 0 ? (v * width * height) / total : 0));
  // Worst aspect ratio of a row laid along a side of length `side`.
  const worst = (row: number[], sum: number, side: number) => {
    let max = 0;
    let min = Infinity;
    for (const i of row) {
      max = Math.max(max, area[i]);
      min = Math.min(min, area[i]);
    }
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let k = 0;
  while (k < idx.length) {
    const side = Math.min(w, h);
    const row = [idx[k]];
    let sum = area[idx[k]];
    let best = worst(row, sum, side);
    let j = k + 1;
    while (j < idx.length) {
      const next = worst([...row, idx[j]], sum + area[idx[j]], side);
      if (next > best) break;
      row.push(idx[j]);
      sum += area[idx[j]];
      best = next;
      j++;
    }
    if (w >= h) {
      // Column on the left edge.
      const cw = sum / h;
      let yy = y;
      for (const i of row) {
        rects[i] = { x, y: yy, w: cw, h: area[i] / cw };
        yy += area[i] / cw;
      }
      x += cw;
      w -= cw;
    } else {
      // Row along the top edge.
      const rh = sum / w;
      let xx = x;
      for (const i of row) {
        rects[i] = { x: xx, y, w: area[i] / rh, h: rh };
        xx += area[i] / rh;
      }
      y += rh;
      h -= rh;
    }
    k = j;
  }
  return rects;
}

/**
 * CSS percentages for a rect inside the virtual box, inset by `gap` virtual
 * units on every side so neighbouring tiles read as separate.
 */
export function rectToPercent(
  r: Rect,
  gap = 2,
  width = TREEMAP_WIDTH,
  height = TREEMAP_HEIGHT,
): { left: string; top: string; width: string; height: string } {
  const pct = (n: number, of: number) => `${((Math.max(0, n) / of) * 100).toFixed(3)}%`;
  return {
    left: pct(r.x + gap, width),
    top: pct(r.y + gap, height),
    width: pct(r.w - 2 * gap, width),
    height: pct(r.h - 2 * gap, height),
  };
}
