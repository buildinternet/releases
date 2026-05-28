import { NextRequest, NextResponse } from "next/server";
import { api } from "@/lib/api";
import { sourceToMarkdown } from "@/lib/formatters";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { sourceAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { productFormatResponse } from "@/lib/format-product";
import { getFormat } from "@/lib/request";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; sourceSlug: string }> },
) {
  const { orgSlug, sourceSlug } = await params;
  const format = getFormat(request);
  const cursorParam = request.nextUrl.searchParams.get("cursor");
  const limitParam = request.nextUrl.searchParams.get("limit");

  // Product-first resolution, matching the bare `/{org}/{slug}` HTML page
  // (which also calls `api.resolve`). After the product-first URL flip (#1190),
  // a bare slug can be a product OR a source, and when both share a slug the
  // product wins. The suffix middleware (`proxy.ts`) routes every bare-slug
  // `.json`/`.md`/`.atom` request here, so this handler must resolve both kinds
  // — otherwise a product's format adapter 404s and a colliding slug serves the
  // wrong entity. See #1207.
  let resolved;
  try {
    resolved = await api.resolve({ orgSlug, slug: sourceSlug });
  } catch (err) {
    return formatErrorResponse(err, "Not found");
  }

  if (resolved.kind === "product") {
    return productFormatResponse(request, orgSlug, resolved.product, format);
  }

  // Source branch. `resolve` already returned the source with a default release
  // window (cursor=null, limit=20). Re-fetch only when the request needs a
  // different tranche: atom pulls a larger fixed set from the start of the feed
  // (ignoring any cursor), and explicit cursor/limit params page beyond the
  // default window.
  let source = resolved.source;
  if (format === "atom" || cursorParam || limitParam) {
    const opts =
      format === "atom"
        ? { cursor: null, limit: ATOM_DEFAULT_MAX_ENTRIES }
        : { cursor: cursorParam, limit: parseInt(limitParam ?? "20", 10) || 20 };
    try {
      source = await api.sourceDetail({ orgSlug, sourceSlug }, opts);
    } catch (err) {
      return formatErrorResponse(err, "Source not found");
    }
  }

  // Defensive: `resolve` and the org-scoped source fetch are both org-scoped, so
  // this should never fire — kept as a guard against a cross-org response.
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
