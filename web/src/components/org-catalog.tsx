import Link from "next/link";
import { OrgAvatar } from "@/components/org-avatar";
import { StubBadge } from "@/components/stub-badge";
import { formatRelativeDate } from "@/lib/formatters";
import { CATALOG_LETTERS, type OrgLetterGroup } from "@/lib/group-orgs";

/** Anchor id for a letter section — "#" can't be a fragment id on its own. */
function letterAnchor(letter: string): string {
  return letter === "#" ? "letter-num" : `letter-${letter}`;
}

/**
 * A-to-Z reference of organizations. Fully server-rendered: a sticky letter
 * jump strip over alphabetically-grouped sections of full-row `<Link>`s. No
 * client state — sorting is fixed (alphabetical) by design.
 */
export function OrgCatalog({ groups }: { groups: OrgLetterGroup[] }) {
  const presentLetters = new Set(groups.map((g) => g.letter));
  return (
    <div>
      <nav
        aria-label="Jump to letter"
        className="sticky top-0 z-10 -mx-6 mb-4 flex flex-wrap gap-0.5 border-b border-stone-200 bg-stone-50/90 px-6 py-2 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-950/90"
      >
        {CATALOG_LETTERS.map((letter) => {
          const present = presentLetters.has(letter);
          if (!present) {
            return (
              <span
                key={letter}
                aria-hidden="true"
                className="w-5 text-center text-[12px] font-medium text-stone-300 dark:text-stone-700"
              >
                {letter}
              </span>
            );
          }
          return (
            <a
              key={letter}
              href={`#${letterAnchor(letter)}`}
              className="w-5 rounded text-center text-[12px] font-medium text-stone-500 hover:bg-stone-200 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
            >
              {letter}
            </a>
          );
        })}
      </nav>

      <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-stone-400 dark:border-stone-800 dark:text-stone-500">
          <span className="flex-1">Organization</span>
          <span className="hidden w-20 text-right sm:block">Last 30d</span>
          <span className="w-24 text-right">Last release</span>
        </div>
        {groups.map((group) => (
          <section key={group.letter} aria-labelledby={letterAnchor(group.letter)}>
            <h2
              id={letterAnchor(group.letter)}
              className="scroll-mt-14 border-b border-stone-200 bg-stone-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400"
            >
              {group.letter}
            </h2>
            <ul>
              {group.orgs.map((org) => (
                <li
                  key={org.slug}
                  className="border-b border-stone-100 last:border-b-0 dark:border-stone-800/50"
                >
                  <Link
                    href={`/${org.slug}`}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800/50"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <OrgAvatar
                        avatarUrl={org.avatarUrl}
                        githubHandle={null}
                        name={org.name}
                        size={18}
                      />
                      <span className="truncate font-medium text-stone-900 dark:text-stone-100">
                        {org.name}
                      </span>
                      <StubBadge status={org.status} className="shrink-0" />
                    </span>
                    <span className="hidden w-20 text-right font-mono text-xs tabular-nums text-stone-600 sm:block dark:text-stone-400">
                      {org.recentReleaseCount > 0 ? org.recentReleaseCount.toLocaleString() : "—"}
                    </span>
                    <span className="w-24 whitespace-nowrap text-right font-mono text-xs tabular-nums text-stone-500 dark:text-stone-400">
                      {formatRelativeDate(org.lastActivity)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
