import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { orgToMarkdown } from "@/lib/formatters";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { orgAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
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
        api.orgReleases(orgSlug, { limit: ATOM_DEFAULT_MAX_ENTRIES }),
      ]);
    } catch (err) {
      return formatErrorResponse(err, "Organization not found");
    }
    return orgAtomResponse(request, org, feed);
  }

  if (format === "md") {
    let org, feed;
    try {
      [org, feed] = await Promise.all([
        api.orgDetail(orgSlug),
        api.orgReleases(orgSlug, { limit: 10 }),
      ]);
    } catch (err) {
      return formatErrorResponse(err, "Organization not found");
    }
    const baseUrl = getBaseUrl(request);
    return markdownResponse(orgToMarkdown(org, { baseUrl, recentReleases: feed.releases }), {
      cache: "dynamic",
    });
  }

  let org;
  try {
    org = await api.orgDetail(orgSlug);
  } catch (err) {
    return formatErrorResponse(err, "Organization not found");
  }

  // The API's public-read endpoints gate admin-only fields (e.g. playbook)
  // behind isValidBearerAuth. The web no longer forwards the admin bearer on
  // these calls, so the response is safe to serve verbatim.
  return NextResponse.json(org);
}
