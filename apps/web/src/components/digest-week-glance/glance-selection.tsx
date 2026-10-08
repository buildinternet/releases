"use client";

import { useState, type ReactNode } from "react";
import { OrgAvatar } from "@/components/org-avatar";
import { ImportanceFlame, ImportanceMarker } from "@/components/importance-marker";
import { GLANCE_TOP_N, type GlanceOrg } from "@/lib/digest-glance";

export interface GlanceTile {
  key: string;
  name: string;
  org: GlanceOrg | null;
  countLabel: string;
  flames: (4 | 5)[];
  /** CSS percentages inside the treemap box. */
  position: { left: string; top: string; width: string; height: string };
  /** Empty when no release in the tile carried composition counts. */
  segments: { key: string; share: number; label: string; background: string; ink: string }[];
  ariaLabel: string;
}

export interface GlanceRow {
  id: string;
  title: string;
  importance: number | null;
  groupKey: string;
  productName: string;
  org: GlanceOrg;
  href: string;
}

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
      aria-label={tile.ariaLabel}
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

/** One "Biggest releases" row (the hero row style), numbered `n`. */
export function GlanceRowLink({ row, n }: { row: GlanceRow; n: number }) {
  return (
    <a
      href={row.href}
      className="flex gap-3 rounded-lg p-2 text-[var(--fg)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
    >
      <span className="pt-0.5 font-mono text-[11px] text-[var(--fg-3)]">
        {String(n).padStart(2, "0")}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-start gap-1.5 text-[14px] leading-snug">
          {/* Line-height box keeps the flame on the first line of a wrapped title. */}
          {(row.importance ?? 0) >= 4 && (
            <span className="flex h-[1.375em] shrink-0 items-center">
              <ImportanceMarker importance={row.importance} />
            </span>
          )}
          <span>{row.title}</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]">
          <OrgAvatar
            avatarUrl={row.org.avatarUrl ?? null}
            githubHandle={row.org.githubHandle ?? null}
            name={row.productName}
            size={14}
          />
          {row.productName}
        </span>
      </span>
    </a>
  );
}

/** A tile's composition band and header, inside whatever positioned wrapper holds it. */
export function GlanceTileBody({ tile }: { tile: GlanceTile }) {
  return (
    <>
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 top-9 flex gap-px">
        {tile.segments.length === 0 ? (
          <span className="flex-1 bg-[var(--surface-2)]" />
        ) : (
          tile.segments.map((s) => (
            <span
              key={s.key}
              className="@container relative flex items-end overflow-hidden"
              style={{ flex: `0 0 ${s.share.toFixed(2)}%`, background: s.background }}
            >
              <span
                className="hidden whitespace-nowrap pb-1.5 pl-[7px] font-mono text-[11px] @min-[96px]:inline"
                style={{ color: s.ink }}
              >
                {s.label}
              </span>
            </span>
          ))
        )}
      </span>
      <span className="absolute inset-x-0 top-0 flex h-9 items-center gap-[7px] overflow-hidden px-2">
        {tile.org && (
          <OrgAvatar
            avatarUrl={tile.org.avatarUrl ?? null}
            githubHandle={tile.org.githubHandle ?? null}
            name={tile.name}
            size={20}
          />
        )}
        <span className="hidden whitespace-nowrap text-[13px] font-semibold text-[var(--fg)] @min-[120px]:inline">
          {tile.name}
        </span>
        <span className="hidden whitespace-nowrap font-mono text-[11px] text-[var(--fg-3)] @min-[150px]:inline">
          {tile.countLabel}
        </span>
        {tile.flames.map((f, i) => (
          <ImportanceFlame key={i} importance={f} />
        ))}
      </span>
    </>
  );
}
