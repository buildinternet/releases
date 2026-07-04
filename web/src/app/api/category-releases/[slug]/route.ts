import { NextRequest, NextResponse } from "next/server";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";
import { withReleaseBodyHtml } from "@/lib/render-release-body";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidCategory(slug)) {
    return NextResponse.json(
      { error: "not_found", message: "Category not found" },
      { status: 404 },
    );
  }
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const includePrereleases = req.nextUrl.searchParams.get("include_prereleases") ?? "";
  const orgs = req.nextUrl.searchParams.get("orgs") ?? "";
  const sourceType = req.nextUrl.searchParams.get("source_type") ?? "";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (includePrereleases) qs.set("include_prereleases", includePrereleases);
  if (orgs) qs.set("orgs", orgs);
  if (sourceType) qs.set("source_type", sourceType);

  const res = await fetch(`${API_URL}/v1/categories/${encodeURIComponent(slug)}/releases?${qs}`, {
    headers: webApiHeaders(),
  });
  const data = await res.json();
  // Pre-render each row's excerpt to HTML server-side (collapsed variant, images
  // stripped) so scroll-appended rows match the SSR initial page and shiki +
  // react-markdown stay off the client. The full body is fetched lazily on
  // expand via `/api/release-body/[id]`.
  if (res.ok && Array.isArray(data?.releases)) {
    data.releases = withReleaseBodyHtml(data.releases, "collapsed");
  }
  return NextResponse.json(data, { status: res.status });
}
