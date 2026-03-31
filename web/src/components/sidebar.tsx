import Link from "next/link";
import { SourceTypeIcon } from "./source-type-icon";

interface SidebarItem { label: string; value: string | number | null; large?: boolean; subtitle?: string; link?: string; externalLink?: string; }
interface SidebarSection { items: SidebarItem[]; }
interface SidebarProps { sections: SidebarSection[]; accounts?: { platform: string; handle: string }[]; formatPath?: string; }

export function Sidebar({ sections, accounts, formatPath }: SidebarProps) {
  return (
    <div className="w-[200px] shrink-0">
      {sections.map((section, si) => (
        <div key={si} className={si > 0 ? "border-t border-stone-200 pt-5" : ""}>
          {section.items.map((item, ii) => (
            <div key={ii} className="mb-6">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">{item.label}</div>
              {item.link ? (
                <Link href={item.link} className="text-sm font-medium text-stone-900 hover:text-stone-600">{String(item.value)}</Link>
              ) : item.externalLink ? (
                <a href={item.externalLink} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-stone-900 hover:text-stone-600">{String(item.value)}</a>
              ) : (
                <>
                  <div className={item.large ? "text-[22px] font-bold text-stone-900" : "text-sm font-medium text-stone-900"}>
                    {item.value ?? "—"}
                  </div>
                  {item.subtitle && <div className="text-xs text-stone-400 mt-0.5">{item.subtitle}</div>}
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {accounts && accounts.length > 0 && (
        <div className="border-t border-stone-200 pt-5 mb-6">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">Accounts</div>
          <div className="space-y-1.5">
            {accounts.map((acc, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[13px] text-stone-600">
                <SourceTypeIcon type={acc.platform} size={13} />
                <span>{acc.handle}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {formatPath && (
        <div className="border-t border-stone-200 pt-5 mb-6 flex gap-2 text-[11px] text-stone-400">
          <a href={`${formatPath}.json`} className="hover:text-stone-600">.json</a>
          <span>·</span>
          <a href={`${formatPath}.md`} className="hover:text-stone-600">.md</a>
        </div>
      )}
    </div>
  );
}
