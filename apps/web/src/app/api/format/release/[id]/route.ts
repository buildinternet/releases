import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { parseReleaseParam } from "@buildinternet/releases-core/release-slug";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { releaseToMarkdown } from "@/lib/formatters";
import { jsonFormatResponse } from "@/lib/json-response";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);
  const format = getFormat(request);

  // A single release has no feed; `.atom` lives on the org, product, and source.
  if (format === "atom") {
    return NextResponse.json(
      { error: "not_found", message: "No Atom feed for a single release" },
      { status: 404 },
    );
  }

  let release;
  try {
    release = await api.release(id);
  } catch (err) {
    return formatErrorResponse(err, "Release not found", format);
  }

  if (format === "json") return jsonFormatResponse(release);

  return markdownResponse(releaseToMarkdown(release, { baseUrl: getBaseUrl(request) }), {
    // The `/release/:id` HTML page is itself `noindex`, so there's no indexable
    // twin to consolidate to — keep this agent/CLI artifact out of the index,
    // matching the `.json`/`.atom` treatment.
    cache: "dynamic",
    noindex: true,
  });
}
