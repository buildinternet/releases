import { logger } from "../lib/logger.js";

/** Resource types to block when rendering pages via Cloudflare Browser Rendering. */
export const CF_REJECT_RESOURCE_TYPES = ["font", "stylesheet"] as const;

async function fetchCloudflareRendered(
  url: string,
  accountId: string,
  apiToken: string,
  format: "content" | "markdown",
): Promise<string | null> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${format}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      rejectResourceTypes: [...CF_REJECT_RESOURCE_TYPES],
      gotoOptions: { waitUntil: "networkidle2" },
    }),
  });

  if (!res.ok) {
    logger.debug(`Cloudflare /${format} returned ${res.status} for ${url}`);
    return null;
  }

  const data = (await res.json()) as { success: boolean; result: string };
  if (!data.success || !data.result?.trim()) return null;

  return data.result;
}

export function fetchCloudflareMarkdown(url: string, accountId: string, apiToken: string): Promise<string | null> {
  return fetchCloudflareRendered(url, accountId, apiToken, "markdown");
}
