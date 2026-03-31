import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { orgToMarkdown } from "@/lib/formatters";
import { getBaseUrl } from "@/lib/base-url";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string }> }
) {
  const { orgSlug } = await params;
  const format = getFormat(request);

  let org;
  try {
    org = await api.orgDetail(orgSlug);
  } catch {
    return NextResponse.json({ error: "not_found", message: "Organization not found" }, { status: 404 });
  }

  if (format === "md") {
    const baseUrl = getBaseUrl(request);
    return new NextResponse(orgToMarkdown(org, { baseUrl }), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json(org);
}
