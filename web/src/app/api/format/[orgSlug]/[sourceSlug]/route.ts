import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { sourceToMarkdown } from "@/lib/formatters";
import { getBaseUrl } from "@/lib/base-url";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> }
) {
  const { orgSlug, sourceSlug } = await params;
  const format = getFormat(request);
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10) || 1;
  const pageSize = parseInt(request.nextUrl.searchParams.get("pageSize") ?? "20", 10) || 20;

  let source;
  try {
    source = await api.sourceDetail(sourceSlug, page, pageSize);
  } catch {
    return NextResponse.json({ error: "not_found", message: "Source not found" }, { status: 404 });
  }

  // Validate org slug matches
  if (!source.org || source.org.slug !== orgSlug) {
    return NextResponse.json({ error: "not_found", message: "Source not found under this organization" }, { status: 404 });
  }

  if (format === "md") {
    const baseUrl = getBaseUrl(request);
    return new NextResponse(sourceToMarkdown(source, { baseUrl }), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  return NextResponse.json(source);
}
