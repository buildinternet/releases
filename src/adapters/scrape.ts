import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Source } from "../db/schema.js";
import { sources } from "../db/schema.js";
import { getDb } from "../db/connection.js";
import type { Adapter, RawRelease, FetchOptions } from "./types.js";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parseChangelog } from "../ai/ingest.js";

export const scrape: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<RawRelease[]> {
    const accountId = config.cloudflareAccountId();
    const apiToken = config.cloudflareApiToken();

    if (!accountId || !apiToken) {
      throw new AdapterError(
        "scrape",
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to use the scrape adapter.",
      );
    }

    // Use /markdown endpoint — more reliable than /json for diverse changelog pages
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;

    const res: Response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: source.url }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AdapterError(
        "scrape",
        `Cloudflare Browser Rendering API returned ${res.status} for ${source.url}: ${body}`,
      );
    }

    const data = await res.json() as { success: boolean; result: string; errors?: Array<{ message: string }> };

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

    // Re-fetch protection: hash the markdown and compare to stored hash
    const contentHash = createHash("sha256")
      .update(markdown)
      .digest("hex");

    if (source.lastContentHash === contentHash) {
      logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
      return [];
    }

    // Store the new hash on the source
    const db = getDb();
    await db
      .update(sources)
      .set({ lastContentHash: contentHash })
      .where(eq(sources.id, source.id));

    // Parse with Anthropic AI ingestion agent
    let parsed;
    try {
      parsed = await parseChangelog(markdown);
    } catch (error) {
      logger.warn(
        `AI parsing failed for ${source.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    logger.info(`Parsed ${parsed.length} releases from ${source.url}`);

    let mapped: RawRelease[] = parsed.map((entry) => ({
      version: entry.version,
      title: entry.title,
      content: entry.content,
      publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
      isBreaking: entry.isBreaking,
    }));

    // Apply date and count limits
    if (options?.since) {
      mapped = mapped.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
    }
    if (options?.maxEntries) {
      mapped = mapped.slice(0, options.maxEntries);
    }

    return mapped;
  },
};
