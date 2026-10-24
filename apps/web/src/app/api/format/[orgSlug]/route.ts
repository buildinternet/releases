import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { orgToMarkdown } from "@/lib/formatters";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { orgAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { jsonFormatResponse } from "@/lib/json-response";
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
      return formatErrorResponse(err, "Organization not found", format);
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
      return formatErrorResponse(err, "Organization not found", format);
    }
    const baseUrl = getBaseUrl(request);
    return markdownResponse(orgToMarkdown(org, { baseUrl, recentReleases: feed.releases }), {
      cache: "dynamic",
      canonical: `${baseUrl}/${orgSlug}`,
    });
  }

  let org;
  try {
    org = await api.orgDetail(orgSlug);
  } catch (err) {
    return formatErrorResponse(err, "Organization not found", format);
  }

  // The web doesn't forward the admin bearer here, so admin-only fields (e.g.
  // playbook) are already gated out and the response is safe to serve verbatim.
  return jsonFormatResponse(org);
}
