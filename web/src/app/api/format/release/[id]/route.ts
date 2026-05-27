import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { releaseToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let release;
  try {
    release = await api.release(id);
  } catch (err) {
    return formatErrorResponse(err, "Release not found");
  }
  return markdownResponse(releaseToMarkdown(release, { baseUrl: getBaseUrl(request) }), {
    cache: "dynamic",
  });
}
