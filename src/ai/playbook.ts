/**
 * Playbook generator — produces a structured markdown document describing
 * how to navigate an org's changelog sources. Deterministic (no AI needed).
 *
 * Two-layer architecture:
 * - **Header** — auto-generated from source metadata. Regenerated on every
 *   source mutation. Agents never edit this directly.
 * - **Notes** — free-form markdown that agents read and write as a whole
 *   document. Stored separately in the DB. Agents can rewrite, reorganize,
 *   or clear notes at any time.
 *
 * The full playbook is assembled at read time by combining header + notes.
 */

import type { Source } from "@releases/core-internal/schema";
import { getSourceMeta } from "@releases/adapters/source-meta";

export interface ProductInfo {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
}

export interface PlaybookInput {
  orgName: string;
  orgSlug: string;
  domain?: string | null;
  sources: Source[];
  products?: ProductInfo[];
}

/**
 * Generate the programmatic header for a playbook.
 * This is the auto-generated portion that reflects current source metadata.
 */
export function generatePlaybookHeader(input: PlaybookInput): string {
  const { orgName, orgSlug, sources, products } = input;

  const active = sources.filter((s) => !s.isHidden);
  const disabled = sources.filter((s) => s.isHidden);
  const productMap = new Map((products ?? []).map((p) => [p.id, p]));
  const hasProducts = active.some((s) => s.productId && productMap.has(s.productId));

  const lines: string[] = [];
  lines.push(`# ${orgName} — Playbook`);
  lines.push("");
  lines.push(`> Agent reference for fetching and maintaining **${orgName}** (\`${orgSlug}\`) changelog sources.`);
  lines.push("");

  // Summary
  const summaryParts: string[] = [];
  summaryParts.push(`**${active.length}** active source${active.length === 1 ? "" : "s"}${disabled.length > 0 ? `, ${disabled.length} disabled` : ""}`);
  if (hasProducts) {
    summaryParts.push(`**${productMap.size}** product${productMap.size === 1 ? "" : "s"}: ${[...productMap.values()].map((p) => p.name).join(", ")}`);
  }
  if (input.domain) {
    summaryParts.push(`domain: ${input.domain}`);
  }
  lines.push(summaryParts.join(" · "));
  lines.push("");

  // Sources table
  if (active.length > 0) {
    lines.push(`## Sources`);
    lines.push("");

    const showProduct = hasProducts;
    if (showProduct) {
      lines.push(`| Name | ID | Type | URL | Product | Last Fetched |`);
      lines.push(`|------|-----|------|-----|---------|--------------|`);
    } else {
      lines.push(`| Name | ID | Type | URL | Last Fetched |`);
      lines.push(`|------|-----|------|-----|--------------|`);
    }

    for (const source of active) {
      lines.push(formatSourceRow(source, productMap, showProduct));
    }
    lines.push("");
  }

  // Disabled sources (compact list, not a full table)
  if (disabled.length > 0) {
    lines.push(`## Disabled`);
    lines.push("");
    for (const source of disabled) {
      const meta = getSourceMeta(source);
      const reason = meta.parseInstructions ? ` — ${meta.parseInstructions.split(".")[0]}.` : "";
      lines.push(`- ~~${source.name}~~ (\`${source.id}\`) ${source.url}${reason}`);
    }
    lines.push("");
  }

  // Parse instructions — shown as footnotes below the table
  const sourcesWithInstructions = [...active, ...disabled]
    .map((s) => ({ source: s, meta: getSourceMeta(s) }))
    .filter(({ meta }) => meta.parseInstructions);
  if (sourcesWithInstructions.length > 0) {
    lines.push(`## Parse Instructions`);
    lines.push("");
    lines.push(`> To update, use \`edit_source\` with metadata — do not edit the playbook header.`);
    lines.push("");
    for (const { source, meta } of sourcesWithInstructions) {
      lines.push(`**${source.name}** (\`${source.slug}\`): ${meta.parseInstructions!.replace(/\n/g, " ")}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatSourceRow(source: Source, productMap: Map<string, ProductInfo>, showProduct: boolean): string {
  const priority = source.fetchPriority ?? "normal";
  const type = priority !== "normal" ? `${source.type} · ${priority}` : source.type;
  const fetched = formatShortDate(source.lastFetchedAt);
  const product = source.productId ? productMap.get(source.productId)?.name ?? "—" : "—";

  if (showProduct) {
    return `| ${source.name} | \`${source.id}\` | ${type} | ${source.url} | ${product} | ${fetched} |`;
  }
  return `| ${source.name} | \`${source.id}\` | ${type} | ${source.url} | ${fetched} |`;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Assemble the full playbook from the auto-generated header and agent notes.
 * Called at read time — the header reflects current metadata, notes are from storage.
 */
export function assemblePlaybook(header: string, notes: string | null): string {
  const trimmedNotes = notes?.trim();
  const notesBody = trimmedNotes
    ? trimmedNotes
    : "_No agent notes yet. Use `update_playbook_notes` to add skill-style notes with three sections: `### Fetch instructions` (per-source playbook — what to do, what to expect), `### Traps` (concise warnings that prevent wasted work), `### Coverage` (what's tracked, what's not, why)._";

  return `${header}\n## Agent Notes\n\n${notesBody}\n`;
}

// ── Legacy helpers (kept for migration from old format) ──

/** Extract just the Notes section from an old-format playbook that stored everything together. */
export function extractNotesFromLegacyPlaybook(content: string): string | null {
  const notesMatch = content.match(/^## (?:Notes|Agent Notes)\n\n([\s\S]*?)(?=\n## |\s*$)/m);
  if (!notesMatch) return null;
  const notes = notesMatch[1].trim();
  if (notes.startsWith("_No agent notes yet")) return null;
  return notes;
}
