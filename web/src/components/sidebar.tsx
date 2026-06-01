import type { ReactNode } from "react";
import Link from "next/link";
import { AccountLink } from "./account-link";
import { InfoTooltip } from "./info-tooltip";
import { formatDate, formatRelativeDate } from "@/lib/formatters";

const STALE_AFTER_DAYS = 14;

function isStale(isoDate: string | null | undefined): boolean {
  if (!isoDate) return false;
  const ageDays = (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > STALE_AFTER_DAYS;
}

export interface SidebarItem {
  label: string;
  value: ReactNode;
  large?: boolean;
  subtitle?: string;
  link?: string;
  externalLink?: string;
  tooltip?: string;
}
export interface SidebarSection {
  items: SidebarItem[];
}
interface SidebarProps {
  sections: SidebarSection[];
  accounts?: { platform: string; handle: string }[];
  formatPath?: string;
  /** ISO timestamp for the "last checked" indicator — rendered as a prominent labeled item with stale warning. */
  lastCheckedAt?: string | null;
  /** ISO timestamp for the most recent successful full fetch — shown in the stale tooltip when it differs from lastCheckedAt. */
  lastFetchedAt?: string | null;
  /** ISO timestamp for when tracking began — rendered as a small footnote at the bottom. */
  trackingSince?: string | null;
}

export function Sidebar({
  sections,
  accounts,
  formatPath,
  lastCheckedAt,
  lastFetchedAt,
  trackingSince,
}: SidebarProps) {
  const stale = isStale(lastCheckedAt);
  return (
    <div className="w-full md:w-[200px] shrink-0">
      {lastCheckedAt && (
        <div className="mb-6">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1.5 flex items-center gap-1">
            Last Checked
            {stale && (
              <InfoTooltip
                text={
                  lastFetchedAt && lastFetchedAt !== lastCheckedAt
                    ? `Last checked ${formatRelativeDate(lastCheckedAt)}; last successful fetch ${formatRelativeDate(lastFetchedAt)}. This data may be out of date.`
                    : `Last checked ${formatRelativeDate(lastCheckedAt)} — this data may be out of date.`
                }
              />
            )}
          </div>
          <div
            className="text-sm font-medium tabular-nums text-stone-900 dark:text-stone-100"
            title={new Date(lastCheckedAt).toLocaleString()}
          >
            {formatRelativeDate(lastCheckedAt)}
          </div>
        </div>
      )}
      {sections.map((section, si) => (
        <div
          key={si}
          className={si > 0 ? "border-t border-stone-200 dark:border-stone-800 pt-5" : ""}
        >
          {section.items.map((item, ii) => (
            <div key={ii} className="mb-6">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1.5 flex items-center gap-1">
                {item.label}
                {item.tooltip && <InfoTooltip text={item.tooltip} />}
              </div>
              {item.link ? (
                <Link
                  href={item.link}
                  className="text-sm font-medium text-stone-900 dark:text-stone-100 hover:text-stone-600 dark:hover:text-stone-300"
                >
                  {item.value}
                </Link>
              ) : item.externalLink ? (
                <a
                  href={item.externalLink}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  className="text-sm font-medium text-stone-900 dark:text-stone-100 hover:text-stone-600 dark:hover:text-stone-300"
                >
                  {item.value}
                </a>
              ) : (
                <>
                  <div
                    className={
                      item.large
                        ? "text-[22px] font-bold tabular-nums text-stone-900 dark:text-stone-100"
                        : "text-sm font-medium tabular-nums text-stone-900 dark:text-stone-100"
                    }
                  >
                    {item.value ?? "—"}
                  </div>
                  {item.subtitle && (
                    <div className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">
                      {item.subtitle}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {accounts && accounts.length > 0 && (
        <div className="border-t border-stone-200 dark:border-stone-800 pt-5 mb-6">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1.5">
            Accounts
          </div>
          <div className="space-y-1.5">
            {accounts.map((acc, i) => (
              <AccountLink key={i} platform={acc.platform} handle={acc.handle} />
            ))}
          </div>
        </div>
      )}
      {(trackingSince || formatPath) && (
        <div className="border-t border-stone-200 dark:border-stone-800 pt-4 mb-6">
          {trackingSince && (
            <div className="text-[11px] mb-3 text-stone-400 dark:text-stone-500">
              Tracking since {formatDate(trackingSince)}
            </div>
          )}
          {formatPath && (
            <div className="flex gap-2 text-[11px] text-stone-400 dark:text-stone-500">
              <a
                href={`${formatPath}.json`}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                .json
              </a>
              <span>·</span>
              <a
                href={`${formatPath}.md`}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                .md
              </a>
              <span>·</span>
              <a
                href={`${formatPath}.atom`}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                .atom
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
