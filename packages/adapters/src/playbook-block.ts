/**
 * Two-tier playbook assembly for the discovery worker.
 *
 * Mirrors `assemblePlaybook()` in `@releases/ai-internal/playbook` — not
 * imported here because discovery is a carved-out workspace without that
 * package wired in; keep the framing in sync by hand if it changes. The
 * header is derived mechanically from source config, so it's ground truth.
 * The notes are a prior agent run's inferences (#1873) — re-feeding them
 * with the header's authority lets a stale guess self-reinforce across
 * runs, so they're rendered as unverified hypotheses to confirm, not facts.
 */

export interface PlaybookPage {
  content?: string | null;
  notes?: string | null;
  updatedAt?: string | null;
}

/** Short "Mon D" date, e.g. "Apr 11". Mirrors the helper in `@releases/ai-internal/playbook`. */
export function formatShortDate(iso: string): string {
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
 * Join the ground-truth header and the demoted notes block into one markdown
 * document. Returns null when the page carries neither.
 */
export function buildPlaybookMarkdown(page: PlaybookPage | null): string | null {
  const header = page?.content?.trim() ?? "";
  const notes = page?.notes?.trim() ?? "";
  const age = notes && page?.updatedAt ? ` — last written ${formatShortDate(page.updatedAt)}` : "";
  const notesBlock = notes
    ? `## Prior observations (unverified${age})\n\n> These are a prior agent run's inferences, not curator- or config-verified facts. Treat them as hypotheses: confirm before relying on them, and correct or remove any that no longer hold.\n\n${notes}`
    : "";
  const parts = [header, notesBlock].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : null;
}
