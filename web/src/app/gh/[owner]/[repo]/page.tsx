import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { adminApi } from "@/lib/api";
import { GhChangelogView } from "@/components/gh-changelog-view";

/**
 * EXPERIMENTAL, LOCAL-DEVELOPMENT ONLY (#1142 follow-up). Renders any public
 * GitHub repo's changelog on demand via the deterministic, no-persistence
 * `POST /v1/changelog/parse` endpoint — no AI, no DB writes. Gated on
 * `NODE_ENV === "development"`: in any built/production environment the route
 * 404s, which is what keeps us out of the design doc's public-route blockers
 * (auth inversion, per-IP rate limiting, repo-size cap, edge caching).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

type SearchParams = { path?: string; source?: string };

export default async function GhChangelogPage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; repo: string }>;
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { owner, repo } = await params;
  const { path, source } = await searchParams;
  const coordinate = `${owner}/${repo}`;

  // Defensive: the route only ever serves github owner/repo coordinates.
  if (!parseCoordinate(coordinate)) notFound();

  // `path` (a monorepo workspace changelog) and `source` are power-user
  // selectors honored from the query string; no visible control yet.
  const sourceInput =
    source === "auto" || source === "github_releases" || source === "changelog_file"
      ? source
      : undefined;

  const [result, indexed] = await Promise.all([
    adminApi.parseChangelog({ repo: coordinate, path, source: sourceInput }),
    adminApi.sourceByCoordinate(coordinate),
  ]);

  if (!result) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="font-mono text-xl font-semibold text-stone-900 dark:text-stone-100">
          {coordinate}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-stone-500 dark:text-stone-400">
          Couldn&apos;t resolve this repo&apos;s changelog. It may not exist, GitHub may have
          rate-limited us, or the admin API key isn&apos;t configured locally (
          <span className="font-mono">RELEASES_API_KEY</span>).
        </p>
      </div>
    );
  }

  return <GhChangelogView result={result} indexed={indexed} />;
}
