/**
 * Source guide generator — produces a structured markdown document describing
 * how to navigate an org's changelog sources. Deterministic (no AI needed).
 *
 * Two-layer architecture:
 * - **Header** — auto-generated from source metadata. Regenerated on every
 *   source mutation. Agents never edit this directly.
 * - **Notes** — free-form markdown that agents read and write as a whole
 *   document. Stored separately in the DB. Agents can rewrite, reorganize,
 *   or clear notes at any time.
 *
 * The full guide is assembled at read time by combining header + notes.
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
}

/**
 * Generate the programmatic header for a source guide.
 * This is the auto-generated portion that reflects current source metadata.
 */
export function generateSourceGuideHeader(input: SourceGuideInput): string {
  const { orgName, orgSlug, sources, products } = input;

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

  // Inline reminder about editing source metadata
  const sourcesWithInstructions = [...active, ...disabled].filter((s) => getSourceMeta(s).parseInstructions);
  if (sourcesWithInstructions.length > 0) {
    lines.push(`> **Note:** ${sourcesWithInstructions.length} source${sourcesWithInstructions.length === 1 ? " has" : "s have"} \`parseInstructions\` configured. To update these, use \`edit_source\` with metadata — do not edit the guide header directly.`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Assemble the full source guide from the auto-generated header and agent notes.
 * Called at read time — the header reflects current metadata, notes are from storage.
 */
export function assembleSourceGuide(header: string, notes: string | null): string {
  const trimmedNotes = notes?.trim();
  const notesBody = trimmedNotes
    ? trimmedNotes
    : "_No agent notes yet. Use `update_source_guide_notes` to add observations about these sources._";

  return `${header}\n## Agent Notes\n\n${notesBody}\n`;
}

function formatSource(source: Source, headingLevel = 3): string {
  const meta = getSourceMeta(source);
  const lines: string[] = [];

  const priority = source.fetchPriority ?? "normal";
  const badges = priority !== "normal" ? `${source.type}, priority: ${priority}` : source.type;
  const heading = "#".repeat(headingLevel);

  lines.push(`${heading} ${source.name} (\`${source.slug}\`)`);
  lines.push("");
  lines.push(`- **URL:** ${source.url}`);
  lines.push(`- **Type:** ${badges}`);

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

// ── Legacy helpers (kept for migration from old format) ──

/** Extract just the Notes section from an old-format guide that stored everything together. */
export function extractNotesFromLegacyGuide(content: string): string | null {
  const notesMatch = content.match(/^## (?:Notes|Agent Notes)\n\n([\s\S]*?)(?=\n## |\s*$)/m);
  if (!notesMatch) return null;
  const notes = notesMatch[1].trim();
  if (notes.startsWith("_No agent notes yet")) return null;
  return notes;
}
