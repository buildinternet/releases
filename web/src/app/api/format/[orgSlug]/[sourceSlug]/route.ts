import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { sourceToMarkdown } from "@/lib/formatters";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { sourceAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> },
) {
  const { orgSlug, sourceSlug } = await params;
  const format = getFormat(request);
  const cursor = request.nextUrl.searchParams.get("cursor");
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "20", 10) || 20;

  let source;
  try {
    // Atom feeds always fetch a fresh tranche of recent entries from the start
    // of the feed so the feed is self-contained — ignore any cursor.
    const opts =
      format === "atom" ? { cursor: null, limit: ATOM_DEFAULT_MAX_ENTRIES } : { cursor, limit };
    source = await api.sourceDetail({ orgSlug, sourceSlug }, opts);
  } catch (err) {
    return formatErrorResponse(err, "Source not found");
  }

  // Validate org slug matches
  if (!source.org || source.org.slug !== orgSlug) {
    return NextResponse.json(
      { error: "not_found", message: "Source not found under this organization" },
      { status: 404 },
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
