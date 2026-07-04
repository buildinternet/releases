import { NextRequest, NextResponse } from "next/server";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "@/lib/env";
import { withReleaseBodyHtml } from "@/lib/render-release-body";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> },
) {
  const { orgSlug, sourceSlug } = await params;
  const cursor = req.nextUrl.searchParams.get("cursor") ?? "";
  const includePrereleases = req.nextUrl.searchParams.get("include_prereleases") ?? "";
  const q = req.nextUrl.searchParams.get("q") ?? "";
  // `full` (App Store / video sources) → the media-bearing markdown variant; the
  // client sets it to match how the row renders its expanded body (see
  // SourceReleaseList.buildQuery). Everything else uses the collapsed variant.
  const full = req.nextUrl.searchParams.get("full") === "true";

  const qs = new URLSearchParams();
  if (cursor) qs.set("cursor", cursor);
  if (includePrereleases) qs.set("include_prereleases", includePrereleases);
  if (q) qs.set("q", q);

  const res = await fetch(`${API_URL}/v1/orgs/${orgSlug}/sources/${sourceSlug}/releases?${qs}`, {
    headers: webApiHeaders(),
  });
  const data = await res.json();
  // Pre-render each release's excerpt to HTML server-side so scroll-appended
  // rows carry the same body markup as the SSR initial page — keeping
  // react-markdown + shiki out of the client bundle.
  if (res.ok && Array.isArray(data?.releases)) {
    data.releases = withReleaseBodyHtml(data.releases, full ? "full" : "collapsed");
  }
  return NextResponse.json(data, { status: res.status });
}
