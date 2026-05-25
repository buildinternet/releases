import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { createRemarkPlugins } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { formatDate } from "@/lib/formatters";
import type { GhChangelogParseResult, IndexedSourceRef } from "@/lib/api";

/**
 * Mintlify-style viewer for the deterministic `POST /v1/changelog/parse` output
 * (experimental, no-persistence — see #1142). Local-development only; the route
 * (`/gh/[owner]/[repo]`) gates on `NODE_ENV`. Renders a sticky version rail
 * beside anchored version sections. Content is the same raw GitHub markdown the
 * release-detail page renders, through the same remark/shiki stack — the parse
 * endpoint produces no AI summaries or media (tier-0), so neither appears here.
 */

const SOURCE_LABELS: Record<NonNullable<GhChangelogParseResult["source"]>, string> = {
  github_releases: "GitHub Releases",
  changelog_file: "CHANGELOG.md",
};

const FORMAT_LABELS: Record<string, string> = {
  "keep-a-changelog": "Keep a Changelog",
  conventional: "Conventional",
  plain: "Plain",
  unknown: "Unknown",
};

// Stable, collision-free anchors — versions can repeat or be null in the wild.
const anchorId = (index: number) => `release-${index}`;

const proseClasses =
  "prose prose-stone dark:prose-invert max-w-none mt-3 text-[14px] leading-relaxed [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_ul]:my-2 [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-2 [&_a]:text-stone-600 dark:[&_a]:text-stone-400 [&_code]:text-[13px] [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none";

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v3.5" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PreBadge() {
  return (
    <span
      title="Pre-release (beta, rc, nightly, preview)"
      className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] uppercase leading-none tracking-wide text-stone-500 dark:bg-stone-800 dark:text-stone-400"
    >
      pre
    </span>
  );
}

function IndexedBanner({ indexed }: { indexed: IndexedSourceRef }) {
  return (
    <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-[13px] dark:border-stone-700 dark:bg-stone-800/50">
      <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-stone-400 dark:text-stone-500" />
      <p className="text-stone-600 dark:text-stone-300">
        We also index this repo.{" "}
        <Link
          href={`/${indexed.orgSlug}/${indexed.sourceSlug}`}
          className="font-medium text-stone-900 underline underline-offset-2 dark:text-stone-100"
        >
          See the curated page
        </Link>{" "}
        for AI summaries, search, and full history.
      </p>
    </div>
  );
}

function EmptyState({ repo }: { repo: string }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 px-6 py-14 text-center dark:border-stone-700">
      <p className="text-[15px] font-medium text-stone-700 dark:text-stone-200">
        No deterministic changelog found
      </p>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-stone-500 dark:text-stone-400">
        <span className="font-mono">{repo}</span> exists, but has neither GitHub Releases with notes
        nor a parseable <span className="font-mono">CHANGELOG.md</span>. This is where an AI
        fallback would step in.
      </p>
    </div>
  );
}

export function GhChangelogView({
  result,
  indexed,
}: {
  result: GhChangelogParseResult;
  indexed: IndexedSourceRef | null;
}) {
  const repoUrl = `https://github.com/${result.repo}`;
  const remarkPlugins = createRemarkPlugins({ repoUrl });
  const { releases } = result;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 border-b border-stone-200 pb-5 dark:border-stone-800">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
          <span>Changelog preview</span>
          <span aria-hidden="true">·</span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
            local dev
          </span>
        </div>
        <h1 className="mt-2 font-mono text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {result.repo}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-stone-500 dark:text-stone-400">
          {result.source && <span>Source: {SOURCE_LABELS[result.source]}</span>}
          {result.source === "changelog_file" && result.format && (
            <>
              <span aria-hidden="true">·</span>
              <span>{FORMAT_LABELS[result.format] ?? result.format}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>
            {releases.length} {releases.length === 1 ? "release" : "releases"}
          </span>
          <span aria-hidden="true">·</span>
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            View on GitHub
          </a>
        </div>
      </header>

      {indexed && <IndexedBanner indexed={indexed} />}

      {releases.length === 0 ? (
        <EmptyState repo={result.repo} />
      ) : (
        <div className="grid gap-8 lg:grid-cols-[180px_minmax(0,1fr)]">
          <nav className="hidden lg:block" aria-label="Versions">
            <div className="sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto pr-2">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400 dark:text-stone-500">
                Versions
              </p>
              <ul className="space-y-0.5">
                {releases.map((r, i) => (
                  <li key={i}>
                    <a
                      href={`#${anchorId(i)}`}
                      className="block truncate rounded px-2 py-1 font-mono text-[12px] text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                    >
                      {r.version ?? r.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <main className="min-w-0 space-y-10">
            {releases.map((r, i) => (
              <section key={i} id={anchorId(i)} className="scroll-mt-8">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-mono text-lg font-semibold text-stone-900 dark:text-stone-100">
                    {r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        {r.title}
                      </a>
                    ) : (
                      r.title
                    )}
                  </h2>
                  {r.publishedAt && (
                    <span className="text-[13px] text-stone-400 dark:text-stone-500">
                      {formatDate(r.publishedAt)}
                    </span>
                  )}
                  {r.prerelease && <PreBadge />}
                </div>
                {r.content.trim() ? (
                  <div className={proseClasses}>
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      rehypePlugins={[rehypeShikiPlugin]}
                      components={detailMarkdownComponents}
                    >
                      {r.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="mt-2 text-[13px] italic text-stone-400 dark:text-stone-500">
                    No release notes.
                  </p>
                )}
              </section>
            ))}
          </main>
        </div>
      )}
    </div>
  );
}
