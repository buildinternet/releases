import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { Header } from "@/components/header";
import { GhChangelogContent, GhChangelogSkeleton } from "@/components/gh-changelog-view";

/**
 * EXPERIMENTAL, LOCAL-DEVELOPMENT ONLY (#1142 follow-up). Renders any public
 * GitHub repo's changelog on demand via the deterministic, no-persistence
 * `POST /v1/changelog/parse` endpoint — no AI, no DB writes. Gated on
 * `NODE_ENV === "development"`: in any built/production environment the route
 * 404s, which is what keeps us out of the design doc's public-route blockers
 * (auth inversion, per-IP rate limiting, repo-size cap, edge caching).
 *
 * The page emits a static shell + skeleton immediately and streams the parse
 * result in via `<Suspense>`, so the several sequential GitHub round-trips the
 * parse endpoint makes don't block the first paint.
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

  const [{ owner, repo }, { path, source }] = await Promise.all([params, searchParams]);
  const coordinate = `${owner}/${repo}`;

  // Defensive: the route only ever serves github owner/repo coordinates.
  if (!parseCoordinate(coordinate)) notFound();

  return (
    <div className="min-h-screen">
      <Header />
      <Suspense
        key={`${coordinate}:${path ?? ""}:${source ?? ""}`}
        fallback={<GhChangelogSkeleton coordinate={coordinate} />}
      >
        <GhChangelogContent coordinate={coordinate} path={path} source={source} />
      </Suspense>
    </div>
  );
}
