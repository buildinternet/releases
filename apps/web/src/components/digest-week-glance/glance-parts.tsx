import { OrgAvatar } from "@/components/org-avatar";
import { ImportanceFlame, ImportanceMarker } from "@/components/importance-marker";
import type { GlanceOrg } from "@/lib/digest-glance";

/**
 * Presentational pieces of the week-at-a-glance card, shared with the digest
 * replay's impact map. Stateless — the card's selection lives in
 * `glance-selection.tsx`.
 */

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
        <span className="flex items-baseline gap-1.5 text-[14px] leading-snug">
          <ImportanceMarker importance={row.importance} />
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
