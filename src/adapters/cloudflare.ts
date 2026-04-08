import { logger } from "../lib/logger.js";

/** Resource types to block when rendering pages via Cloudflare Browser Rendering. */
export const CF_REJECT_RESOURCE_TYPES = ["font", "stylesheet"] as const;

/** Video embed patterns matched in HTML iframes. */
const IFRAME_VIDEO_PATTERNS = [
  { pattern: /youtube\.com\/embed\/([^?"&]+)/, toUrl: (id: string) => `https://www.youtube.com/watch?v=${id}` },
  { pattern: /youtube-nocookie\.com\/embed\/([^?"&]+)/, toUrl: (id: string) => `https://www.youtube.com/watch?v=${id}` },
  { pattern: /player\.vimeo\.com\/video\/(\d+)/, toUrl: (id: string) => `https://vimeo.com/${id}` },
  { pattern: /loom\.com\/embed\/([^?"&]+)/, toUrl: (id: string) => `https://www.loom.com/share/${id}` },
];

/**
 * Extract video embed URLs from HTML iframe elements.
 * Converts embed URLs to watch/share URLs for YouTube, Vimeo, and Loom.
 */
export function extractVideoEmbeds(html: string): string[] {
  const iframeSrcPattern = /<iframe[^>]+src=["']([^"']+)["']/gi;
  const urls: string[] = [];
  const seen = new Set<string>();

  let match;
  while ((match = iframeSrcPattern.exec(html)) !== null) {
    const src = match[1];
    for (const { pattern, toUrl } of IFRAME_VIDEO_PATTERNS) {
      const videoMatch = src.match(pattern);
      if (videoMatch) {
        const url = toUrl(videoMatch[1]);
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
        break;
      }
    }
  }

  return urls;
}

/**
 * Fetch a URL as rendered HTML via Cloudflare Browser Rendering.
 * Returns the HTML string on success, null on failure.
 */
export async function fetchCloudflareHtml(
  url: string,
  accountId: string,
  apiToken: string,
): Promise<string | null> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`;

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
    logger.debug(`Cloudflare /content returned ${res.status} for ${url}`);
    return null;
  }

  const data = (await res.json()) as { success: boolean; result: string };
  if (!data.success || !data.result?.trim()) return null;

  return data.result;
}

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

/**
 * Fetch a URL as markdown via Cloudflare Browser Rendering, with video embeds
 * extracted from the rendered HTML and appended as markdown links.
 * Falls back to markdown-only if the HTML fetch fails.
 */
export async function fetchCloudflareMarkdownWithMedia(
  url: string,
  accountId: string,
  apiToken: string,
): Promise<{ markdown: string; videoUrls: string[] } | null> {
  // Fetch markdown and HTML in parallel
  const [markdown, html] = await Promise.all([
    fetchCloudflareMarkdown(url, accountId, apiToken),
    fetchCloudflareHtml(url, accountId, apiToken),
  ]);

  if (!markdown) return null;

  const videoUrls = html ? extractVideoEmbeds(html) : [];

  if (videoUrls.length > 0) {
    logger.info(`Extracted ${videoUrls.length} video embed(s) from page HTML`);
  }

  // Append video URLs as markdown links so the AI can see and extract them
  let enrichedMarkdown = markdown;
  if (videoUrls.length > 0) {
    const videoLinks = videoUrls.map((u) => `[Video](${u})`).join("\n");
    enrichedMarkdown = `${markdown}\n\n${videoLinks}\n`;
  }

  return { markdown: enrichedMarkdown, videoUrls };
}
