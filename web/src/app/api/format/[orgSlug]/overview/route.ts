import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { overviewToMarkdown } from "@/lib/formatters";
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

  let org;
  try {
    org = await api.orgDetail(orgSlug);
  } catch (err) {
    return formatErrorResponse(err, "Organization not found");
  }

  const overview = org.overview;
  if (!overview) {
    return NextResponse.json(
      { error: "not_found", message: "No overview page exists for this organization" },
      { status: 404 },
    );
  }

  if (format === "md") {
    const baseUrl = getBaseUrl(request);
    return markdownResponse(overviewToMarkdown(overview, { baseUrl, orgSlug }), {
      cache: "dynamic",
      // The overview content also renders on the org page; consolidate there.
      canonical: `${baseUrl}/${orgSlug}`,
    });
  }

  return jsonFormatResponse(overview);
}
