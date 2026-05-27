import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { overviewToMarkdown } from "@/lib/formatters";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
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
    return new NextResponse(overviewToMarkdown(overview, { baseUrl, orgSlug }), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json(overview);
}
