import { logger } from "../lib/logger.js";

/** Resource types to block when rendering pages via Cloudflare Browser Rendering. */
export const CF_REJECT_RESOURCE_TYPES = ["font", "stylesheet"] as const;

const IFRAME_VIDEO_PATTERNS = [
  { pattern: /youtube\.com\/embed\/([^?"&]+)/, toUrl: (id: string) => `https://www.youtube.com/watch?v=${id}` },
  { pattern: /youtube-nocookie\.com\/embed\/([^?"&]+)/, toUrl: (id: string) => `https://www.youtube.com/watch?v=${id}` },
  { pattern: /player\.vimeo\.com\/video\/(\d+)/, toUrl: (id: string) => `https://vimeo.com/${id}` },
  { pattern: /loom\.com\/embed\/([^?"&]+)/, toUrl: (id: string) => `https://www.loom.com/share/${id}` },
];

/**
 * Extract YouTube/Vimeo/Loom watch URLs from `<iframe>` elements in HTML.
 * Converts embed URLs (e.g. youtube.com/embed/ID) to shareable watch URLs.
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

export function fetchCloudflareHtml(url: string, accountId: string, apiToken: string): Promise<string | null> {
  return fetchCloudflareRendered(url, accountId, apiToken, "content");
}

export function fetchCloudflareMarkdown(url: string, accountId: string, apiToken: string): Promise<string | null> {
  return fetchCloudflareRendered(url, accountId, apiToken, "markdown");
}

/**
 * Fetch markdown and rendered HTML in parallel. Video embed URLs from iframes
 * are extracted from the HTML and appended as markdown links.
 * Returns the raw markdown separately so callers can hash before enrichment.
 */
export async function fetchCloudflareMarkdownWithMedia(
  url: string,
  accountId: string,
  apiToken: string,
): Promise<{ rawMarkdown: string; markdown: string; videoUrls: string[] } | null> {
  const [rawMarkdown, html] = await Promise.all([
    fetchCloudflareMarkdown(url, accountId, apiToken),
    fetchCloudflareHtml(url, accountId, apiToken),
  ]);

  if (!rawMarkdown) return null;

  const videoUrls = html ? extractVideoEmbeds(html) : [];

  if (videoUrls.length > 0) {
    logger.info(`Extracted ${videoUrls.length} video embed(s) from page HTML`);
  }

  let markdown = rawMarkdown;
  if (videoUrls.length > 0) {
    const videoLinks = videoUrls.map((u) => `[Video](${u})`).join("\n");
    markdown = `${rawMarkdown}\n\n${videoLinks}\n`;
  }

  return { rawMarkdown, markdown, videoUrls };
}
