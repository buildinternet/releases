import { type NextRequest, NextResponse } from "next/server";
import { isDateKey, etWeekStart } from "@buildinternet/releases-core/dates";
import { api } from "@/lib/api";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { collectionDigestToMarkdown } from "@/lib/formatters";
import { jsonFormatResponse } from "@/lib/json-response";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

/**
 * Format adapters for one weekly digest (`/collections/:slug/digest/:week`).
 * md + json only — same shape as org overview / release adapters. Atom lives
 * on the digests index feed; `.atom` here 308s there.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; week: string }> },
) {
  const { slug, week } = await params;
  const format = getFormat(request);

  // Aggregate feed only — no single-item Atom (mirrors overview/release).
  if (format === "atom") {
    const target = request.nextUrl.clone();
    target.pathname = `/collections/${slug}/digest.atom`;
    return NextResponse.redirect(target, 308);
  }

  if (!isDateKey(week)) {
    return NextResponse.json({ error: "not_found", message: "Invalid week" }, { status: 404 });
  }

  const canonicalWeek = etWeekStart(week);
  if (canonicalWeek !== week) {
    const target = request.nextUrl.clone();
    target.pathname = `/collections/${slug}/digest/${canonicalWeek}.${format}`;
    return NextResponse.redirect(target, 308);
  }

  let collection, digest;
  try {
    [collection, digest] = await Promise.all([
      api.collectionDetail(slug),
      api.collectionWeeklyDigest(slug, week),
    ]);
  } catch (err) {
    return formatErrorResponse(err, "Digest not found");
  }

  const baseUrl = getBaseUrl(request);
  const canonical = `${baseUrl}/collections/${slug}/digest/${week}`;

  if (format === "md") {
    return markdownResponse(collectionDigestToMarkdown(collection, digest, { baseUrl }), {
      cache: "dynamic",
      canonical,
    });
  }

  return jsonFormatResponse({
    collection: { slug: collection.slug, name: collection.name },
    digest,
  });
}
