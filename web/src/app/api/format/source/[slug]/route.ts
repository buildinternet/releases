import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { sourceToMarkdown } from "@/lib/formatters";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { sourceAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const format = getFormat(request);
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10) || 1;
  const pageSize = parseInt(request.nextUrl.searchParams.get("pageSize") ?? "20", 10) || 20;

  let source;
  try {
    const effectivePageSize = format === "atom" ? ATOM_DEFAULT_MAX_ENTRIES : pageSize;
    source = await api.sourceDetail(slug, format === "atom" ? 1 : page, effectivePageSize);
  } catch {
    return NextResponse.json({ error: "not_found", message: "Source not found" }, { status: 404 });
  }

  if (source.org) {
    return NextResponse.json(
      { error: "redirect", message: `This source belongs to org "${source.org.slug}"`, path: `/${source.org.slug}/${source.slug}` },
      { status: 302 }
    );
  }

  if (format === "md") {
    const baseUrl = getBaseUrl(request);
    return new NextResponse(sourceToMarkdown(source, { baseUrl }), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  if (format === "atom") {
    return sourceAtomResponse(request, source);
  }

  return NextResponse.json(source);
}
