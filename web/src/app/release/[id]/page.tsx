import type { Metadata } from "next";
import { safeStringifyJsonLd } from "@/lib/json-ld";
import { parseReleaseParam, releasePath } from "@buildinternet/releases-core/release-slug";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";
import { Suspense, ViewTransition } from "react";
import { api, API_URL, ApiNotFoundError, ApiSetupError } from "@/lib/api";
import { graphqlRequest } from "@/lib/graphql/client";
import { ReleaseDetailDocument } from "@/lib/graphql/__generated__/graphql";
import type { ReleaseDetailQuery } from "@/lib/graphql/__generated__/graphql";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { EXTERNAL_UGC_REL } from "@/lib/sanitize";
import { SetupMessage } from "@/components/setup-message";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { CliCommand } from "@/components/cli-command";
import { AlsoCoveredBy } from "@/components/also-covered-by";
import { RelatedRail } from "@/components/related-rail";
import { ReleaseContent } from "./release-content";
import ReactMarkdown from "react-markdown";
import { createRemarkPlugins, githubRepoUrlFor } from "@/lib/markdown-plugins";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { detailMarkdownComponents } from "@/components/markdown-components";
import { AI_SUMMARY_DISCLAIMER } from "@/lib/copy";
import { RollupBadge } from "@/components/rollup-badge";
import { ImportanceChip } from "@/components/importance-chip";
import { CompositionChip } from "@/components/composition-chip";
import { ReleaseAdminMenu } from "@/components/release-admin-menu";
import { AdminOnly } from "@/components/admin-only";
import { FallbackImage } from "@/components/fallback-image";
import { appStoreIconUrl } from "@/lib/app-source";
import { clampTitle, deriveFeedTitle } from "@/lib/release-title";
import { VideoEmbed } from "@/components/video-embed";
import { resolveVideoEmbed } from "@/lib/video-source";
import { OrgAvatar } from "@/components/org-avatar";
import { ReportIssue } from "@/components/report-issue";
import { productPath } from "@/lib/links";
import { shouldNoIndexRelease } from "@/lib/release-noindex";
import { buildReleaseOpenGraph } from "./release-og";

type GqlRelease = NonNullable<ReleaseDetailQuery["release"]>;
type GqlReleaseSource = GqlRelease["source"];
/** GraphQL types `source.org` non-null; REST can return independent rows with null org. */
type ReleaseSource = Omit<GqlReleaseSource, "org"> & {
  org: GqlReleaseSource["org"] | null;
};
/**
 * `importance` is intersected in explicitly (rather than relying on
 * `GqlRelease` alone) so this compiles ahead of the GraphQL schema regen that
 * adds `Release.importance` server-side — additive, so it's a no-op once the
 * generated type catches up.
 */
type Release = Omit<GqlRelease, "source"> & {
  source: ReleaseSource;
  importance?: number | null;
};

/**
 * Map REST `ReleaseDetail` onto the nested GraphQL shape the page body was
 * written against (source { org, product, appStore, video }).
 */
function mapReleaseFromRest(r: Awaited<ReturnType<typeof api.release>>): Release {
  return {
    id: r.id,
    title: r.title,
    version: r.version,
    type: (r.type ?? "feature") as Release["type"],
    url: r.url,
    publishedAt: r.publishedAt,
    fetchedAt: r.fetchedAt,
    summary: r.summary,
    titleGenerated: r.titleGenerated ?? null,
    titleShort: r.titleShort ?? null,
    content: r.content,
    migrationNotes: r.migrationNotes ?? null,
    importance: r.importance ?? null,
    composition: r.composition
      ? {
          bugs: r.composition.bugs,
          features: r.composition.features,
          enhancements: r.composition.enhancements,
        }
      : null,
    media: (r.media ?? []).map((m) => ({
      type: m.type as Release["media"][number]["type"],
      url: m.url,
      alt: m.alt ?? null,
      r2Url: m.r2Url ?? null,
    })),
    source: {
      slug: r.sourceSlug,
      name: r.sourceName,
      type: r.sourceType as Release["source"]["type"],
      isHidden: r.sourceIsHidden ?? false,
      org: r.org
        ? {
            slug: r.org.slug,
            name: r.org.name,
            avatarUrl: r.org.avatarUrl ?? null,
            isHidden: r.org.isHidden ?? false,
            discovery: (r.org.discovery ?? "curated") as NonNullable<
              ReleaseSource["org"]
            >["discovery"],
          }
        : null,
      product: r.product ?? null,
      appStore: (r.appStore as Release["source"]["appStore"]) ?? null,
      video: (r.video as Release["source"]["video"]) ?? null,
    },
  };
}

/**
 * Server-only GraphQL fetch of the release-detail primary data, shared by
 * `generateMetadata` and the page body. `cache: "no-store"` mirrors the REST
 * predecessor (`api.release`) — a deleted/suppressed release must 404 on the
 * very next request, not on the next ISR revalidate cycle.
 *
 * Falls back to REST when GraphQL fails (#2056). Real 404s rethrow.
 */
async function fetchRelease(idOrUrl: string): Promise<Release> {
  try {
    const data = await graphqlRequest(ReleaseDetailDocument, { idOrUrl }, { cache: "no-store" });
    if (!data.release) throw new ApiNotFoundError(`/v1/graphql release(${idOrUrl})`);
    return data.release;
  } catch (err) {
    if (err instanceof ApiNotFoundError) throw err;
    console.warn(
      JSON.stringify({
        component: "web-ssr",
        event: "release-detail-graphql-fallback",
        route: `/release/${idOrUrl}`,
        err: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        },
      }),
    );
    const rest = await api.release(idOrUrl);
    return mapReleaseFromRest(rest);
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);
  try {
    const release = await fetchRelease(id);
    const { descriptive, versionLabel } = deriveFeedTitle(release);
    const heading = descriptive ?? versionLabel ?? release.title;
    // Keep the version discoverable in the title tag for version-specific search
    // even when the descriptive headline leads.
    const titleHeading = descriptive && versionLabel ? `${heading} (${versionLabel})` : heading;
    const rawDesc = release.summary ?? release.content ?? "";
    const stripped = rawDesc
      .replace(/[#*[\]`>_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const description = stripped.length > 160 ? stripped.slice(0, 157) + "..." : stripped;
    const shouldNoIndex = shouldNoIndexRelease({
      content: release.content,
      summary: release.summary,
      sourceIsHidden: release.source.isHidden,
      org: release.source.org,
    });
    return {
      // Clamp so the <title> doesn't run long enough for search engines to
      // truncate it; the global `%s — releases.sh` template still adds the brand.
      title: clampTitle(`${titleHeading} — ${release.source.name}`),
      description: description || `${heading} release notes for ${release.source.name}`,
      ...(shouldNoIndex ? { robots: { index: false, follow: true } } : {}),
      openGraph: buildReleaseOpenGraph(releasePath(release), {
        publishedAt: release.publishedAt,
        orgSlug: release.source.org?.slug ?? null,
      }),
      alternates: { canonical: releasePath(release) },
    };
  } catch {
    return { title: "Release" };
  }
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default async function ReleaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: routeParam } = await params;
  const { id } = parseReleaseParam(routeParam);

  let raw: Release;
  try {
    raw = await fetchRelease(id);
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    // The release is suppressed, deleted, or coverage-only (all return 404
    // from GET /v1/releases/:id via the releases_visible filter). Before
    // giving up, check whether this id is a coverage-side row with a live
    // canonical: if so, 308 to the canonical detail page so crawlers and
    // humans land somewhere useful.
    //
    // Ideal status for a permanently-removed release with no canonical sibling
    // is 410 Gone, but Next.js App Router server components don't expose a
    // direct 410 path — the only hooks are notFound() (→ 404) and
    // permanentRedirect() (→ 308). notFound() is the closest safe fallback;
    // a custom Route Handler or middleware could emit a true 410 if needed.
    // permanentRedirect() signals by throwing, so it must run OUTSIDE this
    // try — the catch below would swallow the redirect and fall through to
    // notFound(). Resolve the target inside, redirect after.
    let coverageRedirect: string | null = null;
    try {
      const coverage = await api.coverage(id);
      if (coverage.role === "coverage" && coverage.canonical.sibling != null) {
        // The canonical is visible — send the crawler/user there permanently.
        // Bare-ID target is fine: the canonical's own page renders directly
        // (no slug redirect, #2072) and carries its own `rel=canonical`.
        coverageRedirect = `/release/${coverage.canonical.canonicalId}`;
      }
    } catch {
      // Coverage lookup failed (network error, parse error) — fall through
      // to notFound() so we don't accidentally swallow the original error.
    }
    if (coverageRedirect) {
      permanentRedirect(coverageRedirect);
    }
    notFound();
  }

  // Friendly-URL canonicalization: bare-ID, stale-slug, and mangled-slug
  // segments all render at their given URL rather than 308ing to the current
  // canonical `/release/<id>-<slug>` form (#2072) — a followed redirect cost
  // a second full render for no benefit, since `<link rel="canonical">` (see
  // generateMetadata above) and the JSON-LD `url` (below) already point
  // crawlers at the slugged form. The ID is the routing key; the slug is
  // derived from the current title and is purely decorative here. The
  // coverage-side redirect above is unrelated — that one sends a different
  // release entity to its canonical sibling and stays a 308.
  //
  // Reversible in one commit: reinstate `permanentRedirect(releasePath(raw))`
  // here if `rel=canonical` proves too weak a consolidation signal (watch
  // Search Console for `Duplicate, Google chose different canonical` on
  // `/release/*`).

  // Flatten the GraphQL `source { org, product, appStore, video }` nesting
  // back onto the release-detail shape the rest of this page (and its shared
  // helpers, e.g. `deriveFeedTitle`/`shouldNoIndexRelease`) were written
  // against — this mirrors the REST `ReleaseDetail` wire shape 1:1.
  const release = {
    ...raw,
    sourceSlug: raw.source.slug,
    sourceName: raw.source.name,
    sourceType: raw.source.type,
    org: raw.source.org,
    product: raw.source.product,
    appStore: raw.source.appStore,
    video: raw.source.video,
    // GraphQL nulls out absent optional strings; the REST-derived MediaItem
    // type (still used by ReleaseContent + related components) expects them
    // omitted instead.
    media: raw.media.map((m) => ({
      type: m.type,
      url: m.url,
      ...(m.alt != null ? { alt: m.alt } : {}),
      ...(m.r2Url != null ? { r2Url: m.r2Url } : {}),
    })),
  };

  const sourcePath = release.org
    ? `/${release.org.slug}/${release.sourceSlug}`
    : `/source/${release.sourceSlug}`;

  const appStore = release.appStore ?? null;
  // Video embed: dispatch on the wire `video` facet to a playable URL + label
  // (provider routing lives in resolveVideoEmbed), and pick the thumbnail for
  // the click-to-play facade.
  const videoEmbed = resolveVideoEmbed(release.video, release.url, release.media);
  const videoThumb = videoEmbed
    ? (release.media?.find((m) => m.type === "image" || m.type === "gif")?.url ?? null)
    : null;
  // App Store screenshots are store marketing; for an embedded video the player
  // replaces the (single) thumbnail item — drop the media gallery in both cases.
  const media = appStore || videoEmbed ? [] : (release.media ?? []);

  const repoUrl = release.sourceType === "github" ? githubRepoUrlFor(release.url) : null;
  const detailRemarkPlugins = createRemarkPlugins({ repoUrl });

  // Title hierarchy mirrors the feed (#feed-title): the descriptive title leads
  // the H1 and the version is demoted to a subtitle. The org/source already
  // appears in the breadcrumb and byline, so the heading doesn't repeat the
  // product name. See web/src/lib/release-title.ts.
  const { descriptive, versionLabel } = deriveFeedTitle(release);
  const heading = descriptive ?? versionLabel ?? release.title;
  // Breadcrumb leaf: the product page when the source is grouped under a
  // product, else the source. The release title is intentionally not a crumb —
  // it leads the H1 directly below. One descriptor feeds both the visible trail
  // and the JSON-LD BreadcrumbList so the two can't drift.
  const leafName = release.product ? release.product.name : release.sourceName || "Release";
  const leafPath = release.product
    ? productPath(release.org?.slug ?? null, release.product.slug)
    : sourcePath;
  // Version subtitle, shown only when the descriptive title is leading the H1.
  const showVersionSubtitle = !!descriptive && !!versionLabel;
  const trimmedSummary = release.summary?.trim();
  const hasBody = release.content?.trim();
  const devAdmin = isLocalAdminEnabled();

  // JSON-LD must carry the same slugged canonical as <link rel=canonical>/OG,
  // or crawlers see conflicting canonical signals.
  const releaseUrl = `https://releases.sh${releasePath(release)}`;
  // Structured-data breadcrumb mirrors the visible trail: Home → Org → leaf,
  // where the leaf is the product (when grouped) or the source.
  const leafItem = `https://releases.sh${leafPath}`;
  const breadcrumbItems = [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://releases.sh" },
    ...(release.org
      ? [
          {
            "@type": "ListItem",
            position: 2,
            name: release.org.name,
            item: `https://releases.sh/${release.org.slug}`,
          },
          { "@type": "ListItem", position: 3, name: leafName, item: leafItem },
        ]
      : [{ "@type": "ListItem", position: 2, name: leafName, item: leafItem }]),
  ];
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: heading,
        // Our generated summary, attributed to us (below) as the page's own
        // editorial layer — distinct from the derived body it summarizes.
        ...(trimmedSummary ? { description: trimmedSummary } : {}),
        datePublished: release.publishedAt ?? undefined,
        mainEntityOfPage: { "@type": "WebPage", "@id": releaseUrl },
        url: releaseUrl,
        // Releases authors this rendition (the enriched headline + the summary);
        // the underlying changelog is the external source's, expressed via
        // `sourceOrganization` + `isBasedOn`/`sameAs` below — not via `author`.
        author: { "@type": "Organization", name: "Releases", url: "https://releases.sh" },
        publisher: { "@type": "Organization", name: "Releases", url: "https://releases.sh" },
        ...(release.org?.name || release.sourceName
          ? {
              sourceOrganization: {
                "@type": "Organization",
                name: release.org?.name ?? release.sourceName,
              },
            }
          : {}),
        // Declare this page as a derivative of the original changelog/release
        // note it indexes. `isBasedOn` (source provenance) + `sameAs` (same item
        // on the canonical origin) tell crawlers we aggregate an external source
        // rather than duplicate it — the correct framing for an aggregator.
        ...(release.url ? { isBasedOn: release.url, sameAs: release.url } : {}),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: breadcrumbItems,
      },
    ],
  };

  return (
    <div className="min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeStringifyJsonLd(jsonLd) }}
      />
      <div className="max-w-3xl mx-auto px-6">
        {/* Breadcrumb: [org logo] Org / Product (or Source). The release title
            is not repeated here — it leads the H1 directly below. */}
        <div className="pt-5 flex items-center gap-1.5 text-[13px] text-stone-400 dark:text-stone-500">
          {release.org && (
            <>
              <OrgAvatar
                avatarUrl={release.org.avatarUrl ?? null}
                githubHandle={null}
                name={release.org.name}
                size={18}
              />
              <Link
                href={`/${release.org.slug}`}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                {release.org.name}
              </Link>
              <span className="text-stone-300 dark:text-stone-600">/</span>
            </>
          )}
          <Link
            href={leafPath}
            className="text-stone-600 dark:text-stone-300 font-medium hover:text-stone-900 dark:hover:text-stone-100"
          >
            {leafName}
          </Link>
        </div>

        {/* Header */}
        <div className="mt-6 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <ViewTransition name={`rel-${id}`} default="none">
              <h1 className="text-[28px] font-bold tracking-tight text-stone-900 dark:text-stone-100">
                {heading}
              </h1>
            </ViewTransition>
            <RollupBadge type={release.type} />
            <ImportanceChip importance={release.importance} />
          </div>
          {showVersionSubtitle && (
            <p className="text-lg text-stone-600 dark:text-stone-400 mt-1">{versionLabel}</p>
          )}
          <div className="flex items-center gap-3 mt-3 text-[13px] text-stone-400 dark:text-stone-500">
            {release.publishedAt && <span>{formatDate(release.publishedAt)}</span>}
            <span className="flex items-center gap-1.5">
              <SourceTypeIcon type={release.sourceType} size={14} />
              <Link href={sourcePath} className="hover:text-stone-600 dark:hover:text-stone-300">
                {release.sourceName}
              </Link>
            </span>
            {appStore && (
              <span className="flex items-center gap-1.5">
                {appStore.iconUrl && (
                  <FallbackImage
                    src={appStoreIconUrl(appStore.iconUrl, 64)}
                    alt=""
                    width={16}
                    height={16}
                    className="rounded-[4px]"
                  />
                )}
                Available for {appStore.platform === "macos" ? "macOS" : "iOS"}
              </span>
            )}
            {release.url && (
              <a
                href={release.url}
                target="_blank"
                rel={EXTERNAL_UGC_REL}
                className="hover:text-stone-600 dark:hover:text-stone-300"
              >
                View original ↗
              </a>
            )}
            <ReportIssue
              context={{
                kind: "release",
                name: heading,
                id: release.id,
                path: releasePath(release),
              }}
              label="Report"
              align="right"
              placement="below"
            />
            <AdminOnly devAdmin={devAdmin}>
              <span className="ml-auto">
                <ReleaseAdminMenu
                  releaseId={release.id}
                  redirectTo={sourcePath}
                  rawJsonHref={`${API_URL}/v1/releases/${encodeURIComponent(release.id)}`}
                />
              </span>
            </AdminOnly>
          </div>
          {/* Composition legend + copy-command stack vertically — both are
              inline-flex, so without a block wrapper they collide on one line. */}
          <div className="mt-3 flex flex-col items-start gap-3">
            <CompositionChip composition={release.composition} />
            <CliCommand identifier={release.id} className="" />
          </div>
        </div>

        {/* Content */}
        <div className="pb-12">
          {videoEmbed && (
            <div className="mb-6">
              <VideoEmbed
                embedUrl={videoEmbed.embedUrl}
                thumbnailUrl={videoThumb}
                title={heading}
                providerLabel={videoEmbed.label}
              />
            </div>
          )}
          {trimmedSummary && hasBody && (
            <aside className="bg-stone-50 dark:bg-stone-900/50 border border-stone-200 dark:border-stone-800 rounded-lg p-5 mb-6">
              <div className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500 font-medium mb-3">
                Summary
              </div>
              <div className="prose prose-stone dark:prose-invert max-w-none text-[15px] leading-relaxed text-stone-700 dark:text-stone-200 [&_p]:my-0 [&_code]:text-sm [&_code]:bg-stone-100 dark:[&_code]:bg-stone-800 [&_code]:px-1 [&_code]:rounded [&_code::before]:content-none [&_code::after]:content-none [&_a]:text-stone-600 dark:[&_a]:text-stone-400">
                <ReactMarkdown
                  remarkPlugins={detailRemarkPlugins}
                  rehypePlugins={[rehypeShikiPlugin]}
                  components={detailMarkdownComponents}
                >
                  {trimmedSummary}
                </ReactMarkdown>
              </div>
              <div className="mt-4 pt-3 border-t border-stone-200 dark:border-stone-800 text-[11px] text-stone-400 dark:text-stone-500">
                {AI_SUMMARY_DISCLAIMER}
              </div>
            </aside>
          )}
          <ReleaseContent
            content={release.content}
            title={release.title}
            media={media}
            repoUrl={repoUrl}
            sourceUrl={release.url}
            migrationNotes={release.migrationNotes ?? null}
          />
          <Suspense fallback={null}>
            <AlsoCoveredBy anchorReleaseId={release.id} />
          </Suspense>
          {release.org && (
            <Suspense fallback={null}>
              <RelatedRail
                anchorReleaseId={release.id}
                scope="org"
                heading={`More from ${release.org.name}`}
              />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <RelatedRail
              anchorReleaseId={release.id}
              scope="global"
              heading="From other products"
              excludeOrgSlug={release.org?.slug ?? null}
            />
          </Suspense>
          {release.fetchedAt && (
            <p
              className="text-xs text-stone-400 dark:text-stone-500 mt-8"
              title={release.fetchedAt}
            >
              Fetched {formatDate(release.fetchedAt)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
