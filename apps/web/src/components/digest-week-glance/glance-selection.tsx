"use client";

import { useState, type ReactNode } from "react";
import { GLANCE_TOP_N } from "@/lib/digest-glance";
import { GlanceRowLink, GlanceTileBody, type GlanceRow, type GlanceTile } from "./glance-parts";

/**
 * Selection island for the week-at-a-glance card: clicking a tile filters the
 * "Biggest releases" list to that product and dims the other tiles. Rows
 * arrive pre-ranked from the server; this only filters and slices.
 */
export function GlanceSelection({
  tiles,
  rows,
  legend,
}: {
  tiles: GlanceTile[];
  rows: GlanceRow[];
  legend: ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedTile = selected ? tiles.find((t) => t.key === selected) : undefined;
  const shown = (selected ? rows.filter((r) => r.groupKey === selected) : rows).slice(
    0,
    GLANCE_TOP_N,
  );

  return (
    <>
      {tiles.length > 0 && (
        <>
          <div className="relative w-full aspect-[712/300] max-[520px]:aspect-[4/3]">
            {tiles.map((t) => (
              <Tile
                key={t.key}
                tile={t}
                pressed={selected === t.key}
                dimmed={selected != null && selected !== t.key}
                onSelect={() => setSelected(selected === t.key ? null : t.key)}
              />
            ))}
          </div>
          {legend}
        </>
      )}

      <div className="flex flex-col gap-0.5 border-t border-[var(--line)] pt-3">
        <div className="ml-2 flex min-h-8 items-center justify-between gap-3">
          <h3 className="font-mono text-[10.5px] font-normal uppercase tracking-[0.16em] text-[var(--fg-3)]">
            {selectedTile ? `Biggest from ${selectedTile.name}` : "Biggest releases"}
          </h3>
          {selectedTile && (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="h-8 rounded-lg border border-[var(--line-2)] px-3 text-[12px] font-medium text-[var(--fg-2)] transition-colors hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              Show all
            </button>
          )}
        </div>
        <ol className="flex flex-col gap-0.5">
          {shown.map((r, i) => (
            <li key={r.id}>
              <GlanceRowLink row={r} n={i + 1} />
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

function Tile({
  tile,
  pressed,
  dimmed,
  onSelect,
}: {
  tile: GlanceTile;
  pressed: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${tile.ariaLabel}. Select to filter the list.`}
      onClick={onSelect}
      className={`@container absolute cursor-pointer overflow-hidden rounded-md bg-[var(--surface-2)] text-left transition-opacity duration-200 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
        pressed
          ? "shadow-[inset_0_0_0_2px_var(--fg)]"
          : "hover:shadow-[inset_0_0_0_2px_var(--fg-3)]"
      } ${dimmed ? "opacity-35" : "opacity-100"}`}
      style={tile.position}
    >
      <GlanceTileBody tile={tile} />
    </button>
  );
}
