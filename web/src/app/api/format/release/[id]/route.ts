import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { parseReleaseParam } from "@buildinternet/releases-core/release-slug";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { releaseToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawParam } = await params;
  const { id } = parseReleaseParam(rawParam);
  let release;
  try {
    release = await api.release(id);
  } catch (err) {
    return formatErrorResponse(err, "Release not found");
  }
  return markdownResponse(releaseToMarkdown(release, { baseUrl: getBaseUrl(request) }), {
    // No standalone `/release/:id` HTML page exists, so there's no canonical
    // twin to consolidate to — keep this agent/CLI artifact out of the index,
    // matching the `.json`/`.atom` treatment.
    cache: "dynamic",
    noindex: true,
  });
}
