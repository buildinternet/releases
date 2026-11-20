/**
 * Agent-friendly markdown for the CLI's local MCP server (`releases serve`).
 *
 * The full formatter set lives in `packages/rendering` (private, worker-side);
 * the published CLI can't depend on it, so only what the CLI actually renders
 * is kept here.
 */

import type { UnifiedSearchResponse } from "../api/types.js";

export interface FormatOptions {
  /** Base URL for canonical links (e.g. "https://releases.sh") */
  baseUrl?: string;
}

/** Trim a full ISO timestamp to just the date portion. */
function isoDateOnly(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function yamlLine(key: string, value: string | number | null | undefined): string {
  if (value == null || value === "") return "";
  return `${key}: ${value}`;
}

// ── Search Results → Markdown ──────────────────────────────────────

export function searchToMarkdown(results: UnifiedSearchResponse, opts: FormatOptions = {}): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(yamlLine("query", results.query));
  lines.push("---");
  lines.push("");

  if (results.orgs.length > 0) {
    lines.push("## Organizations");
    lines.push("");
    for (const org of results.orgs) {
      const url = opts.baseUrl ? ` — [view](${opts.baseUrl}/${org.slug})` : "";
      lines.push(
        `- **${org.name}** (\`${org.slug}\`)${org.category ? ` [${org.category}]` : ""}${url}`,
      );
    }
    lines.push("");
  }

  // Read the new `catalog` field, falling back to the deprecated `products`
  // alias so older API deployments keep working. Drop the fallback once the
  // alias is removed from the wire.
  const legacyCatalog = (results as unknown as Record<string, unknown>)["products"] as
    | UnifiedSearchResponse["catalog"]
    | undefined;
  const catalog: UnifiedSearchResponse["catalog"] = results.catalog ?? legacyCatalog ?? [];

  if (catalog.length > 0) {
    lines.push("## Catalog");
    lines.push("");
    for (const p of catalog) {
      const orgInfo = p.orgSlug ? ` (${p.orgName})` : "";
      const viewSlug =
        p.entryType === "source" && p.sourceSlug ? p.sourceSlug : `product/${p.slug}`;
      const url =
        opts.baseUrl && p.orgSlug ? ` — [view](${opts.baseUrl}/${p.orgSlug}/${viewSlug})` : "";
      lines.push(
        `- **${p.name}** (\`${p.slug}\`)${orgInfo}${p.category ? ` [${p.category}]` : ""}${url}`,
      );
    }
    lines.push("");
  }

  if (results.releases.length > 0) {
    lines.push("## Releases");
    lines.push("");
    for (const r of results.releases) {
      const date = r.publishedAt ? ` (${isoDateOnly(r.publishedAt)})` : "";
      const version = r.version ? ` ${r.version}` : "";
      lines.push(`- **${r.sourceName}${version}**${date}: ${r.title}`);
      if (r.summary) {
        lines.push(`  > ${r.summary}`);
      }
    }
    lines.push("");
  }

  if (results.orgs.length === 0 && catalog.length === 0 && results.releases.length === 0) {
    lines.push("No results found.");
    lines.push("");
  }

  return lines.join("\n");
}
