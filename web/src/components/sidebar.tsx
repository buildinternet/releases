import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";
import { InfoTooltip } from "./info-tooltip";
import { LocalTimestamp } from "./local-timestamp";

function stalenessColor(isoDate: string | null | undefined): string {
  if (!isoDate) return "text-stone-400 dark:text-stone-500";
  const ageMs = Date.now() - new Date(isoDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > 7) return "text-red-400 dark:text-red-500";
  if (ageDays > 1) return "text-amber-500 dark:text-amber-400";
  return "text-stone-400 dark:text-stone-500";
}

interface SidebarItem { label: string; value: string | number | null; large?: boolean; subtitle?: string; link?: string; externalLink?: string; tooltip?: string; }
interface SidebarSection { items: SidebarItem[]; }
interface SidebarProps { sections: SidebarSection[]; accounts?: { platform: string; handle: string }[]; formatPath?: string; footnote?: string | null; footnoteTitle?: string | null; }

export function Sidebar({ sections, accounts, formatPath, footnote, footnoteTitle }: SidebarProps) {
  return (
    <div className="w-full md:w-[200px] shrink-0">
      {sections.map((section, si) => (
        <div key={si} className={si > 0 ? "border-t border-stone-200 dark:border-stone-800 pt-5" : ""}>
          {section.items.map((item, ii) => (
            <div key={ii} className="mb-6">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1.5 flex items-center gap-1">
                {item.label}
                {item.tooltip && <InfoTooltip text={item.tooltip} />}
              </div>
              {item.link ? (
                <Link href={item.link} className="text-sm font-medium text-stone-900 dark:text-stone-100 hover:text-stone-600 dark:hover:text-stone-300">{String(item.value)}</Link>
              ) : item.externalLink ? (
                <a href={item.externalLink} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-stone-900 dark:text-stone-100 hover:text-stone-600 dark:hover:text-stone-300">{String(item.value)}</a>
              ) : (
                <>
                  <div className={item.large ? "text-[22px] font-bold tabular-nums text-stone-900 dark:text-stone-100" : "text-sm font-medium tabular-nums text-stone-900 dark:text-stone-100"}>
                    {item.value ?? "—"}
                  </div>
                  {item.subtitle && <div className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">{item.subtitle}</div>}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {accounts && accounts.length > 0 && (
        <div className="border-t border-stone-200 dark:border-stone-800 pt-5 mb-6">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1.5">Accounts</div>
          <div className="space-y-1.5">
            {accounts.map((acc, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[13px] text-stone-600 dark:text-stone-400">
                <SourceTypeIcon type={acc.platform} size={13} />
                <span>{acc.handle}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {(footnote || formatPath) && (
        <div className="border-t border-stone-200 dark:border-stone-800 pt-4 mb-6">
          {footnoteTitle ? (
            <div className={`text-[11px] mb-3 cursor-default ${stalenessColor(footnoteTitle)}`}>
              <LocalTimestamp iso={footnoteTitle} prefix="Last fetched " />
            </div>
          ) : footnote ? (
            <div className={`text-[11px] mb-3 cursor-default text-stone-400 dark:text-stone-500`}>{footnote}</div>
          ) : null}
          {formatPath && (
            <div className="flex gap-2 text-[11px] text-stone-400 dark:text-stone-500">
              <a href={`${formatPath}.json`} className="hover:text-stone-600 dark:hover:text-stone-300">.json</a>
              <span>·</span>
              <a href={`${formatPath}.md`} className="hover:text-stone-600 dark:hover:text-stone-300">.md</a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
