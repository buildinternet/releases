import Link from "next/link";
import { categoryDisplayName } from "@buildinternet/releases-core/categories";
import { toSlug } from "@buildinternet/releases-core/slug";
import type { CollectionListItem } from "@buildinternet/releases-api-types";
import { accountUrl, AccountIcon, formatAccountHandle } from "@/components/account-link";
import { ExternalLinkIcon } from "@/components/account/icons";
import { domainHref } from "@/lib/source-display";
import { formatRelativeDate, formatMonthYear } from "@/lib/formatters";
import { GlobeIcon } from "./icons";

/**
 * Right-hand context rail for the org page (the design's About / Accounts /
 * Export aside). Sticky on wide screens, stacked below the main column on
 * narrow ones. Server component — all data is already loaded by the org layout;
 * it only reads tokens + the shared account/domain helpers.
 */
export function OrgContextRail({
  domain,
  category,
  tags,
  collections,
  accounts,
  trackingSince,
  lastCheckedAt,
  formatPath,
}: {
  domain: string | null | undefined;
  category: string | null | undefined;
  tags: string[] | null | undefined;
  collections: CollectionListItem[] | null | undefined;
  accounts: { platform: string; handle: string }[];
  trackingSince: string | null | undefined;
  lastCheckedAt: string | null | undefined;
  /** Path the export links hang off, e.g. `/anthropic` → `/anthropic.json`. */
  formatPath: string;
}) {
  const chips: { label: string; href: string }[] = [];
  if (category)
    chips.push({ label: categoryDisplayName(category), href: `/categories/${category}` });
  for (const t of tags ?? []) chips.push({ label: t, href: `/tags/${toSlug(t)}` });

  const trackingLabel = formatMonthYear(trackingSince);

  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 md:w-[268px] lg:sticky lg:top-20">
      {/* About */}
      <div className="rounded-[13px] bg-[var(--surface-2)] px-[17px] py-4">
        <RailEyebrow>About</RailEyebrow>
        {domain && (
          <a
            href={domainHref(domain)}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="mt-3 flex items-center gap-2.5 font-mono text-[13px] text-[var(--fg)] transition-colors hover:text-[var(--accent)]"
          >
            <GlobeIcon className="h-[15px] w-[15px] shrink-0 text-[var(--fg-3)]" />
            {domain}
          </a>
        )}
        {chips.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {chips.map((c) => (
              <Link
                key={c.href}
                href={c.href}
                className="inline-flex h-6 items-center rounded-[7px] border border-[var(--line)] bg-[var(--page)] px-2.5 text-[12px] text-[var(--fg-2)] transition-colors hover:text-[var(--fg)]"
              >
                {c.label}
              </Link>
            ))}
          </div>
        )}
        {lastCheckedAt && (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-[var(--fg-3)]">
            <span className="org-status-dot h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--good)]" />
            <span>
              Checked {formatRelativeDate(lastCheckedAt)}
              {trackingLabel ? ` · since ${trackingLabel}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Accounts */}
      {accounts.length > 0 && (
        <div>
          <RailEyebrow className="ml-0.5">Accounts</RailEyebrow>
          <div className="mt-2.5 flex flex-col gap-px">
            {accounts.map((acc, i) => {
              const url = accountUrl(acc.platform, acc.handle);
              if (!url) return null;
              return (
                <a
                  key={i}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer me"
                  className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-[var(--fg-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
                >
                  <AccountIcon
                    platform={acc.platform}
                    size={16}
                    className="shrink-0 text-[var(--fg-3)]"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    {formatAccountHandle(acc.platform, acc.handle)}
                  </span>
                  <ExternalLinkIcon className="h-[13px] w-[13px] shrink-0 text-[var(--fg-3)]" />
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Featured in */}
      {collections && collections.length > 0 && (
        <div>
          <RailEyebrow className="ml-0.5">Featured in</RailEyebrow>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {collections.map((c) => (
              <Link
                key={c.slug}
                href={`/collections/${c.slug}`}
                className="inline-flex h-6 items-center rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-2.5 text-[12px] text-[var(--fg-2)] transition-colors hover:text-[var(--fg)]"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Export */}
      <div>
        <RailEyebrow className="ml-0.5">Export</RailEyebrow>
        <div className="mt-2.5 flex gap-2">
          {(["json", "md", "atom"] as const).map((ext) => (
            <a
              key={ext}
              href={`${formatPath}.${ext}`}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] py-[7px] font-mono text-[11.5px] text-[var(--fg-2)] transition-colors hover:text-[var(--fg)]"
            >
              .{ext}
            </a>
          ))}
        </div>
      </div>
    </aside>
  );
}

function RailEyebrow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-3)] ${className}`}
    >
      {children}
    </div>
  );
}
