import { logger } from "../lib/logger.js";

/** Resource types to block when rendering pages via Cloudflare Browser Rendering. */
export const CF_REJECT_RESOURCE_TYPES = ["image", "media", "font", "stylesheet"] as const;

/**
 * Fetch a URL as markdown via Cloudflare Browser Rendering.
 * Returns the markdown string on success, null on failure.
 */
export async function fetchCloudflareMarkdown(
  url: string,
  accountId: string,
  apiToken: string,
): Promise<string | null> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;

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
    logger.debug(`Cloudflare returned ${res.status} for ${url}`);
    return null;
  }

  const data = (await res.json()) as { success: boolean; result: string };
  if (!data.success || !data.result?.trim()) return null;

  return data.result;
}
