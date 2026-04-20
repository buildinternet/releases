import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { orgToMarkdown } from "@/lib/formatters";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { orgAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string }> },
) {
  const { orgSlug } = await params;
  const format = getFormat(request);

  if (format === "atom") {
    let org, feed;
    try {
      [org, feed] = await Promise.all([
        api.orgDetail(orgSlug),
        api.orgReleases(orgSlug, undefined, ATOM_DEFAULT_MAX_ENTRIES),
      ]);
    } catch {
      return NextResponse.json(
        { error: "not_found", message: "Organization not found" },
        { status: 404 },
      );
    }
    return orgAtomResponse(request, org, feed);
  }

  if (format === "md") {
    let org, feed;
    try {
      [org, feed] = await Promise.all([
        api.orgDetail(orgSlug),
        api.orgReleases(orgSlug, undefined, 10),
      ]);
    } catch {
      return NextResponse.json(
        { error: "not_found", message: "Organization not found" },
        { status: 404 },
      );
    }
    const baseUrl = getBaseUrl(request);
    return markdownResponse(orgToMarkdown(org, { baseUrl, recentReleases: feed.releases }), {
      cache: "dynamic",
    });
  }

  let org;
  try {
    org = await api.orgDetail(orgSlug);
  } catch {
    return NextResponse.json(
      { error: "not_found", message: "Organization not found" },
      { status: 404 },
    );
  }

  return NextResponse.json(org);
}
