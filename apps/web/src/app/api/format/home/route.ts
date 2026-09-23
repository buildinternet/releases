import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { getBaseUrl } from "@/lib/base-url";
import { homeToMarkdown } from "@/lib/formatters-web";
import { markdownResponse } from "@/lib/markdown-response";

export async function GET(request: NextRequest) {
  const [stats, orgsResult] = await Promise.all([api.stats(), api.orgs()]);
  const baseUrl = getBaseUrl(request);
  return markdownResponse(
    homeToMarkdown({
      stats,
      orgs: orgsResult.items,
      baseUrl,
    }),
    { cache: "dynamic", canonical: `${baseUrl}/` },
  );
}
