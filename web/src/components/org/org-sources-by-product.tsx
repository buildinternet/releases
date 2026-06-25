import Link from "next/link";
import type { SourceListItem, OrgDetail } from "@/lib/api";
import { sourceOrProductPath } from "@/lib/links";
import { formatRelativeDate } from "@/lib/formatters";
import { Sparkline } from "@/components/sparkline";
import { StateBadge, getHiddenStateBadge } from "@/components/source-table";

const TYPE_LABELS: Record<string, string> = {
  github: "GitHub",
  feed: "Feed",
  scrape: "Website",
  agent: "Agent",
  appstore: "App Store",
};

/** Per-type accent for the source badge text (design's `typeColor`). */
const TYPE_COLORS: Record<string, string> = {
  github: "var(--fg-2)",
  feed: "var(--accent)",
  scrape: "var(--fix)",
  agent: "oklch(0.66 0.15 300)",
  appstore: "var(--fg-2)",
};

function sourceState(source: SourceListItem): { label: string; title: string } | null {
  const hidden = getHiddenStateBadge(source);
  if (hidden) return hidden;
  if (source.fetchPriority === "paused") {
    return { label: "Paused", title: "Fetching is paused for this source" };
  }
  return null;
}

function isInactive(source: SourceListItem): boolean {
  return Boolean(source.isHidden) || source.fetchPriority === "paused" || source.releaseCount === 0;
}

function sortByImportance(a: SourceListItem, b: SourceListItem): number {
  if (a.isPrimary && !b.isPrimary) return -1;
  if (!a.isPrimary && b.isPrimary) return 1;
  return b.releaseCount - a.releaseCount;
}

interface SourceGroup {
  key: string;
  name: string;
  items: SourceListItem[];
}

/**
 * Sources tab — feeds grouped by the product each belongs to (the design's
 * grouped layout). Server component; reuses the shared state-badge logic and
 * `Sparkline`. Sources without a product fall into a trailing "Other" group.
 */
export function OrgSourcesByProduct({
  sources,
  products,
  orgSlug,
  orgName,
  sourceSparklines,
}: {
  sources: SourceListItem[];
  products: OrgDetail["products"];
  orgSlug: string;
  orgName: string;
  sourceSparklines?: Record<string, number[]>;
}) {
  const productMap = new Map(products.map((p) => [p.slug, p.name]));
  const bySlug = new Map<string, SourceListItem[]>();
  const other: SourceListItem[] = [];
  for (const s of sources) {
    if (s.productSlug && productMap.has(s.productSlug)) {
      const list = bySlug.get(s.productSlug) ?? [];
      list.push(s);
      bySlug.set(s.productSlug, list);
    } else {
      other.push(s);
    }
  }

  const groups: SourceGroup[] = [];
  for (const p of products) {
    const items = bySlug.get(p.slug);
    if (items && items.length > 0) {
      groups.push({ key: p.slug, name: p.name, items: [...items].sort(sortByImportance) });
    }
  }
  if (other.length > 0) {
    groups.push({
      key: "__other",
      name: groups.length > 0 ? "Other sources" : "Sources",
      items: [...other].sort(sortByImportance),
    });
  }

  return (
    <div className="mt-5">
      <p className="mb-[18px] max-w-[60ch] text-[13.5px] text-[var(--fg-2)]">
        Feeds we watch to assemble {orgName}&rsquo;s release history. Grouped by the product each
        one belongs to.
      </p>
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="mb-2.5 flex items-center gap-2.5 pl-0.5">
              <span className="text-[13px] font-semibold text-[var(--fg)]">{g.name}</span>
              <span className="font-mono text-[11.5px] text-[var(--fg-3)]">
                {g.items.length} {g.items.length === 1 ? "source" : "sources"}
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]">
              {g.items.map((s) => (
                <SourceRow
                  key={s.slug}
                  source={s}
                  orgSlug={orgSlug}
                  spark={sourceSparklines?.[s.slug]}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceRow({
  source,
  orgSlug,
  spark,
}: {
  source: SourceListItem;
  orgSlug: string;
  spark?: number[];
}) {
  const state = sourceState(source);
  const muted = isInactive(source);
  return (
    <div
      className={`flex items-center gap-3.5 border-t border-[var(--line)] px-4 py-3 transition-colors first:border-t-0 hover:bg-[var(--surface-2)] ${
        muted ? "opacity-60" : ""
      }`}
    >
      <span
        className="flex h-[22px] w-[72px] shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface-2)] font-mono text-[10.5px] font-semibold tracking-[0.04em]"
        style={{ color: TYPE_COLORS[source.type] ?? "var(--fg-2)" }}
      >
        {TYPE_LABELS[source.type] ?? source.type}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            href={sourceOrProductPath({
              orgSlug,
              sourceSlug: source.slug,
              productSlug: source.productSlug,
            })}
            className="truncate text-[13.5px] font-medium text-[var(--fg)] hover:text-[var(--accent)]"
          >
            {source.name}
          </Link>
          {state && <StateBadge label={state.label} title={state.title} />}
        </div>
        {source.url && (
          <div
            className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--fg-3)]"
            title={source.url}
          >
            {source.url.replace(/^https?:\/\//, "")}
          </div>
        )}
      </div>
      <Sparkline
        data={spark ?? []}
        id={`src-${source.slug}`}
        width={64}
        height={20}
        color="var(--fg-3)"
        className="hidden shrink-0 sm:block"
      />
      <span className="w-[42px] shrink-0 text-right font-mono text-[13px] text-[var(--fg)]">
        {source.releaseCount}
      </span>
      <span className="hidden w-[56px] shrink-0 text-right font-mono text-[11.5px] text-[var(--fg-3)] sm:inline">
        {formatRelativeDate(source.latestAddedAt ?? source.latestDate ?? null)}
      </span>
    </div>
  );
}
