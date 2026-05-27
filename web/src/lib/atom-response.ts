import { NextRequest, NextResponse } from "next/server";
import type {
  SourceDetail,
  OrgDetail,
  OrgReleasesFeedResponse,
  CollectionDetail,
  CollectionReleasesResponse,
  CategoryReleasesResponse,
} from "@/lib/api";
import {
  sourceToAtom,
  orgReleasesToAtom,
  collectionReleasesToAtom,
  categoryReleasesToAtom,
} from "@/lib/atom";
import { atomEtag, formatLastModified, shouldReturn304 } from "@releases/rendering/atom-http";
import { getBaseUrl } from "@/lib/base-url";

/**
 * Build an Atom response with conditional-request handling. Feed readers
 * poll frequently — 304s cut the bulk of the bandwidth cost.
 */
export function atomResponse(
  request: NextRequest,
  body: string,
  opts: { lastModified?: string | null } = {},
): NextResponse {
  const etag = atomEtag(body);
  const lastModifiedHeader = formatLastModified(opts.lastModified);

  const matches = shouldReturn304(
    etag,
    lastModifiedHeader,
    request.headers.get("if-none-match"),
    request.headers.get("if-modified-since"),
  );

  if (matches) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        ...(lastModifiedHeader ? { "Last-Modified": lastModifiedHeader } : {}),
      },
    });
  }

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      ETag: etag,
      // Short shared cache + revalidate so feed readers get timely updates
      // but origin load stays reasonable under burst polling.
      "Cache-Control": "public, max-age=300, s-maxage=300",
      ...(lastModifiedHeader ? { "Last-Modified": lastModifiedHeader } : {}),
    },
  });
}

/** Render a `SourceDetail` into an Atom response using the shared formatter. */
export function sourceAtomResponse(request: NextRequest, source: SourceDetail): NextResponse {
  const baseUrl = getBaseUrl(request);
  const body = sourceToAtom(source, { baseUrl });
  const lastModified = source.releases[0]?.publishedAt ?? source.lastFetchedAt ?? null;
  return atomResponse(request, body, { lastModified });
}

/** Render a collection's aggregated release feed into an Atom response. */
export function collectionAtomResponse(
  request: NextRequest,
  collection: Pick<CollectionDetail, "slug" | "name" | "description">,
  feed: CollectionReleasesResponse,
): NextResponse {
  const baseUrl = getBaseUrl(request);
  const body = collectionReleasesToAtom(
    {
      collectionSlug: collection.slug,
      collectionName: collection.name,
      description: collection.description,
      releases: feed.releases,
    },
    { baseUrl },
  );
  const lastModified = feed.releases[0]?.publishedAt ?? null;
  return atomResponse(request, body, { lastModified });
}

/** Render a category rollup's aggregated release feed into an Atom response. */
export function categoryAtomResponse(
  request: NextRequest,
  category: { slug: string; name: string },
  feed: CategoryReleasesResponse,
): NextResponse {
  const baseUrl = getBaseUrl(request);
  const body = categoryReleasesToAtom(
    {
      categorySlug: category.slug,
      categoryName: category.name,
      releases: feed.releases,
    },
    { baseUrl },
  );
  const lastModified = feed.releases[0]?.publishedAt ?? null;
  return atomResponse(request, body, { lastModified });
}

/** Render an org's aggregated release feed into an Atom response. */
export function orgAtomResponse(
  request: NextRequest,
  org: Pick<OrgDetail, "slug" | "name" | "lastFetchedAt" | "overview">,
  feed: OrgReleasesFeedResponse,
): NextResponse {
  const baseUrl = getBaseUrl(request);
  const body = orgReleasesToAtom(
    {
      orgSlug: org.slug,
      orgName: org.name,
      releases: feed.releases,
      overview: org.overview ?? null,
    },
    { baseUrl },
  );
  const lastModified = feed.releases[0]?.publishedAt ?? org.lastFetchedAt ?? null;
  return atomResponse(request, body, { lastModified });
}
