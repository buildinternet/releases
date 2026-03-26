import type { Source } from "../db/schema.js";
import type { Adapter, RawRelease } from "./types.js";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parseChangelog } from "../ai/ingest.js";

interface CloudflareMarkdownResponse {
  success: boolean;
  result: string;
  errors?: Array<{ message: string }>;
}

export const scrape: Adapter = {
  async fetch(source: Source): Promise<RawRelease[]> {
    const accountId = config.cloudflareAccountId();
    const apiToken = config.cloudflareApiToken();

    if (!accountId || !apiToken) {
      throw new AdapterError(
        "scrape",
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to use the scrape adapter.",
      );
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: source.url }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AdapterError(
        "scrape",
        `Cloudflare Browser Rendering API returned ${response.status} for ${source.url}: ${body}`,
      );
    }

    const data: CloudflareMarkdownResponse = await response.json();

    if (!data.success) {
      const messages = data.errors?.map((e) => e.message).join("; ") ?? "unknown error";
      throw new AdapterError(
        "scrape",
        `Cloudflare Browser Rendering failed for ${source.url}: ${messages}`,
      );
    }

    const markdown = data.result;

    if (!markdown || markdown.trim().length === 0) {
      logger.warn(`Cloudflare returned empty markdown for ${source.url}`);
      return [];
    }

    let parsed;
    try {
      parsed = await parseChangelog(markdown);
    } catch (error) {
      logger.warn(
        `AI parsing failed for ${source.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    return parsed.map((entry) => ({
      version: entry.version,
      title: entry.title,
      content: entry.content,
      publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
      isBreaking: entry.isBreaking,
      // Don't set url to the source page URL — it's the same for all entries
      // and would trigger the UNIQUE(source_id, url) constraint. Dedup for
      // scraped entries relies on content_hash instead.
      url: undefined,
    }));
  },
};
