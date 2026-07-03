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
 * The notes body may be prefixed with a YAML frontmatter fence carrying
 * typed configuration that cron code reads directly (e.g. `fetchQuirks` —
 * per-source change-detector hints). Agents edit the markdown below the
 * fence; the fence itself round-trips untouched via
 * `parsePlaybookNotes` / `serializePlaybookNotes`.
 *
 * The full playbook is assembled at read time by combining header + notes.
 */

import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

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
  lines.push(
    `> Agent reference for fetching and maintaining **${orgName}** (\`${orgSlug}\`) changelog sources.`,
  );
  lines.push("");

  // Summary
  const summaryParts: string[] = [];
  summaryParts.push(
    `**${active.length}** active source${active.length === 1 ? "" : "s"}${disabled.length > 0 ? `, ${disabled.length} disabled` : ""}`,
  );
  if (hasProducts) {
    summaryParts.push(
      `**${productMap.size}** product${productMap.size === 1 ? "" : "s"}: ${[...productMap.values()].map((p) => p.name).join(", ")}`,
    );
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
    lines.push(
      `> To update, use \`manage_source(action=edit)\` with metadata — do not edit the playbook header.`,
    );
    lines.push("");
    for (const { source, meta } of sourcesWithInstructions) {
      lines.push(
        `**${source.name}** (\`${source.slug}\`): ${meta.parseInstructions!.replace(/\n/g, " ")}`,
      );
      lines.push("");
    }
  }

  // Category allowlists — shown as footnotes below the table
  const sourcesWithCategoryAllow = [...active, ...disabled]
    .map((s) => ({ source: s, meta: getSourceMeta(s) }))
    .filter(({ meta }) => meta.categoryAllow && meta.categoryAllow.length > 0);
  if (sourcesWithCategoryAllow.length > 0) {
    lines.push(`## Category Allowlists`);
    lines.push("");
    lines.push(
      `> Feed items whose \`<category>\` doesn't intersect the allowlist are dropped at ingest. Items with no category are dropped too.`,
    );
    lines.push("");
    for (const { source, meta } of sourcesWithCategoryAllow) {
      const list = meta.categoryAllow!.map((c) => `\`${c}\``).join(", ");
      lines.push(`**${source.name}** (\`${source.slug}\`): ${list}`);
      lines.push("");
    }
  }

  // Keyword allowlists (title/URL substring) — shown as footnotes below the table
  const sourcesWithKeywordAllow = [...active, ...disabled]
    .map((s) => ({ source: s, meta: getSourceMeta(s) }))
    .filter(({ meta }) => meta.feedKeywordAllow && meta.feedKeywordAllow.length > 0);
  if (sourcesWithKeywordAllow.length > 0) {
    lines.push(`## Keyword Allowlists`);
    lines.push("");
    lines.push(
      `> Feed items are kept only when one of these keywords appears (case-insensitive) in the item's title or URL slug. All others are dropped at ingest.`,
    );
    lines.push("");
    for (const { source, meta } of sourcesWithKeywordAllow) {
      const list = meta.feedKeywordAllow!.map((c) => `\`${c}\``).join(", ");
      lines.push(`**${source.name}** (\`${source.slug}\`): ${list}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatSourceRow(
  source: Source,
  productMap: Map<string, ProductInfo>,
  showProduct: boolean,
): string {
  const priority = source.fetchPriority ?? "normal";
  const type = priority !== "normal" ? `${source.type} · ${priority}` : source.type;
  const fetched = formatShortDate(source.lastFetchedAt);
  const product = source.productId ? (productMap.get(source.productId)?.name ?? "—") : "—";

  if (showProduct) {
    return `| ${source.name} | \`${source.id}\` | ${type} | ${source.url} | ${product} | ${fetched} |`;
  }
  return `| ${source.name} | \`${source.id}\` | ${type} | ${source.url} | ${fetched} |`;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Assemble the full playbook from the auto-generated header and agent notes.
 * Called at read time — the header reflects current metadata, notes are from storage.
 *
 * The two blocks carry different authority (#1873): the header is derived
 * mechanically from source config (curator-set fields, feed URLs that parse)
 * so it's presented as ground truth. The notes section is free-form prose a
 * prior agent run wrote down from *inference*, not verification — re-feeding
 * it with the same authority as the header lets a stale guess self-reinforce
 * across runs. It's rendered under a distinct "Prior observations
 * (unverified)" heading with an explicit hedge, so a future run treats it as
 * a hypothesis to confirm rather than a fact to restate.
 *
 * `notesUpdatedAt` (the knowledge_pages row's `updatedAt`) is surfaced as an
 * age cue on the heading when notes exist, so an agent can weigh a
 * six-month-old observation differently from a fresh one without a new
 * per-fact provenance model (that's #1872, out of scope here).
 */
export function assemblePlaybook(
  header: string,
  notes: string | null,
  notesUpdatedAt?: string | null,
): string {
  const trimmedNotes = notes?.trim();

  if (!trimmedNotes) {
    const placeholder =
      "_No prior observations yet. Use `manage_playbook(action=update_notes)` to add skill-style notes with three sections: `### Fetch instructions` (per-source playbook — what to do, what to expect), `### Traps` (concise warnings that prevent wasted work), `### Coverage` (what's tracked, what's not, why)._";
    return `${header}\n## Prior observations (unverified)\n\n${placeholder}\n`;
  }

  const age = notesUpdatedAt ? ` — last written ${formatShortDate(notesUpdatedAt)}` : "";
  return `${header}\n## Prior observations (unverified${age})\n\n> These are a prior agent run's inferences, not curator- or config-verified facts. Treat them as hypotheses: confirm before relying on them, and correct or remove any that no longer hold.\n\n${trimmedNotes}\n`;
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

// ── Playbook frontmatter (typed config embedded in notes) ──

export const fetchQuirkSchema = z.object({
  changeDetector: z.enum([
    "etag",
    "content-length",
    "body-hash",
    "body-hash-filtered",
    "unreliable",
  ]),
  rationale: z.string().min(1),
  tier: z.enum(["normal", "low"]).optional(),
  changeProbeUrl: z.url().optional(),
});

export type FetchQuirk = z.infer<typeof fetchQuirkSchema>;

export const playbookFrontmatterSchema = z
  .object({
    fetchQuirks: z.record(z.string(), fetchQuirkSchema).optional(),
  })
  .strict();

export type PlaybookFrontmatter = z.infer<typeof playbookFrontmatterSchema>;

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)*([\s\S]*)$/;

/**
 * Split stored notes into its (optional) YAML frontmatter and free-form body.
 *
 * Frontmatter must be at the very top of the notes, delimited by `---` fences
 * on their own lines. If the fence is missing or the YAML fails to validate,
 * `frontmatter` is `null` and the full notes string is returned as `body` —
 * callers treat invalid frontmatter as absent rather than throwing, so a
 * hand-edit mistake can't take a playbook out of the read path.
 */
export function parsePlaybookNotes(notes: string | null | undefined): {
  frontmatter: PlaybookFrontmatter | null;
  body: string;
} {
  if (!notes) return { frontmatter: null, body: "" };

  const match = notes.match(FRONTMATTER_FENCE);
  if (!match) return { frontmatter: null, body: notes };

  const [, yamlText, body] = match;
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    return { frontmatter: null, body: notes };
  }
  const result = playbookFrontmatterSchema.safeParse(raw ?? {});
  if (!result.success) return { frontmatter: null, body: notes };

  return { frontmatter: result.data, body };
}

/**
 * Serialize a frontmatter object + markdown body back into a stored notes
 * string. Omits the fence entirely when the frontmatter is empty so we don't
 * leave a decorative `---\n---` fragment on every playbook.
 */
export function serializePlaybookNotes(
  frontmatter: PlaybookFrontmatter | null,
  body: string | null,
): string {
  const trimmedBody = body?.trimEnd() ?? "";
  const hasContent = frontmatter != null && Object.values(frontmatter).some((v) => v !== undefined);

  if (!hasContent) return trimmedBody;

  const validated = playbookFrontmatterSchema.parse(frontmatter);
  const yaml = stringifyYaml(validated).trimEnd();
  return trimmedBody.length > 0 ? `---\n${yaml}\n---\n\n${trimmedBody}` : `---\n${yaml}\n---\n`;
}

/**
 * Read the typed `fetchQuirks` entry for a given source slug out of stored
 * playbook notes. Returns `null` when the playbook has no frontmatter, no
 * `fetchQuirks` map, or no entry for that slug. Phase 2 (#517) reads this in
 * `pollOne` to route scrape-no-feed / agent sources to a change detector.
 */
export function loadFetchQuirks(
  notes: string | null | undefined,
  sourceSlug: string,
): FetchQuirk | null {
  const { frontmatter } = parsePlaybookNotes(notes);
  return frontmatter?.fetchQuirks?.[sourceSlug] ?? null;
}
