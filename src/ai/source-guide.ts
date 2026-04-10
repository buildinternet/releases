/**
 * Source guide generator — produces a structured markdown document describing
 * how to navigate an org's changelog sources. Deterministic (no AI needed).
 *
 * Agents read this before fetch operations. Agents can append notes as they
 * discover things about sources.
 */

import type { Source } from "../db/schema.js";
import { getSourceMeta } from "../adapters/feed.js";

export interface ProductInfo {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
}

export interface SourceGuideInput {
  orgName: string;
  orgSlug: string;
  domain?: string | null;
  sources: Source[];
  products?: ProductInfo[];
  /** Existing notes section to preserve across regenerations */
  existingNotes?: string;
}

/** Generate a source guide markdown document for an org. */
export function generateSourceGuide(input: SourceGuideInput): string {
  const { orgName, orgSlug, sources, products, existingNotes } = input;

  const active = sources.filter((s) => !s.isHidden);
  const disabled = sources.filter((s) => s.isHidden);
  const productMap = new Map((products ?? []).map((p) => [p.id, p]));
  const hasProducts = active.some((s) => s.productId && productMap.has(s.productId));

  const lines: string[] = [];
  lines.push(`# ${orgName} — Source Guide`);
  lines.push("");
  lines.push(`> Agent reference for fetching and maintaining **${orgName}** (\`${orgSlug}\`) changelog sources.`);
  lines.push("");

  // Summary
  lines.push(`## Overview`);
  lines.push("");
  lines.push(`- **${active.length}** active source${active.length === 1 ? "" : "s"}${disabled.length > 0 ? `, ${disabled.length} disabled` : ""}`);
  if (hasProducts) {
    lines.push(`- **${productMap.size}** product${productMap.size === 1 ? "" : "s"}: ${[...productMap.values()].map((p) => p.name).join(", ")}`);
  }
  if (input.domain) {
    lines.push(`- Primary domain: ${input.domain}`);
  }
  lines.push("");

  // Active sources — grouped by product when products exist
  if (active.length > 0) {
    if (hasProducts) {
      // Group sources by product
      const byProduct = new Map<string, Source[]>();
      const unassigned: Source[] = [];

      for (const source of active) {
        if (source.productId && productMap.has(source.productId)) {
          const group = byProduct.get(source.productId) ?? [];
          group.push(source);
          byProduct.set(source.productId, group);
        } else {
          unassigned.push(source);
        }
      }

      lines.push(`## Sources by Product`);
      lines.push("");

      for (const [productId, productSources] of byProduct) {
        const product = productMap.get(productId)!;
        lines.push(`### ${product.name} (\`${product.slug}\`)`);
        lines.push("");
        if (product.description) {
          lines.push(`${product.description}`);
          lines.push("");
        }
        for (const source of productSources) {
          lines.push(formatSource(source, 4));
        }
      }

      if (unassigned.length > 0) {
        const productNames = [...productMap.values()].map((p) => p.name);
        lines.push(`### Organization-Level Sources`);
        lines.push("");
        lines.push(`_Not tied to a specific product, but content may span any of: ${productNames.join(", ")}. Check individual releases for product relevance._`);
        lines.push("");
        for (const source of unassigned) {
          lines.push(formatSource(source, 4));
        }
      }
    } else {
      lines.push(`## Active Sources`);
      lines.push("");
      for (const source of active) {
        lines.push(formatSource(source));
      }
    }
  }

  // Disabled sources
  if (disabled.length > 0) {
    lines.push(`## Disabled Sources`);
    lines.push("");
    for (const source of disabled) {
      lines.push(formatSource(source));
    }
  }

  // Agent notes section
  lines.push(`## Notes`);
  lines.push("");
  if (existingNotes) {
    lines.push(existingNotes);
  } else {
    lines.push("_No agent notes yet. Agents can append observations here as they work with these sources._");
  }
  lines.push("");

  return lines.join("\n");
}

function formatSource(source: Source, headingLevel = 3): string {
  const meta = getSourceMeta(source);
  const lines: string[] = [];

  const priority = source.fetchPriority ?? "normal";
  const badges = [source.type, priority !== "normal" ? `priority: ${priority}` : null].filter(Boolean);
  const heading = "#".repeat(headingLevel);

  lines.push(`${heading} ${source.name} (\`${source.slug}\`)`);
  lines.push("");
  lines.push(`- **URL:** ${source.url}`);
  lines.push(`- **Type:** ${badges.join(", ")}`);

  if (meta.feedUrl) {
    lines.push(`- **Feed:** ${meta.feedUrl}`);
  }
  if (meta.markdownUrl) {
    lines.push(`- **Markdown URL:** ${meta.markdownUrl}`);
  }
  if (meta.provider) {
    lines.push(`- **Provider:** ${meta.provider}`);
  }
  if (meta.crawlEnabled) {
    lines.push(`- **Crawl mode:** enabled${meta.crawlPattern ? ` (pattern: \`${meta.crawlPattern}\`)` : ""}`);
  }
  if (meta.autoEnrich) {
    lines.push(`- **Auto-enrich:** yes (feed content is summary-only)`);
  }

  lines.push(`- **Last fetched:** ${source.lastFetchedAt ?? "never"}`);

  if (meta.parseInstructions) {
    lines.push(`- **Parse instructions:**`);
    lines.push(`  > ${meta.parseInstructions.replace(/\n/g, "\n  > ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Extract just the Notes section from existing guide content. */
export function extractNotes(content: string): string | undefined {
  const notesMatch = content.match(/^## Notes\n\n([\s\S]*?)(?=\n## |\n$)/m);
  if (!notesMatch) return undefined;
  const notes = notesMatch[1].trim();
  if (notes.startsWith("_No agent notes yet")) return undefined;
  return notes;
}

/** Append a note to the Notes section of a guide. Returns the updated guide content. */
export function appendNote(content: string, note: string, author?: string): string {
  const timestamp = new Date().toISOString().split("T")[0];
  const prefix = author ? `[${author}, ${timestamp}]` : `[${timestamp}]`;
  const formatted = `- ${prefix} ${note}`;

  const existingNotes = extractNotes(content);
  const notesSection = existingNotes ? `${existingNotes}\n${formatted}` : formatted;

  // Replace the notes section in the content
  return content.replace(
    /^## Notes\n\n[\s\S]*?(?=\n## |\s*$)/m,
    `## Notes\n\n${notesSection}\n`,
  );
}
