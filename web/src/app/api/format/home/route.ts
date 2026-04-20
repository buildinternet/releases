import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { getBaseUrl } from "@/lib/base-url";
import { homeToMarkdown } from "@/lib/formatters-web";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(request: NextRequest) {
  const [stats, orgs, independentSources] = await Promise.all([
    api.stats(),
    api.orgs(),
    api.sources(true),
  ]);
  return markdownResponse(
    homeToMarkdown({
      stats,
      orgs,
      independentSources,
      baseUrl: getBaseUrl(request),
    }),
    { cache: "dynamic" },
  );
}
