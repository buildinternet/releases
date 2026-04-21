/**
 * Tool-UX eval tasks. Each task is a realistic worker-agent prompt exercising
 * a read-then-write flow so find/search/get telemetry shows up naturally.
 *
 * Not a bun-test suite — these are dispatched to managed agents by hand (or
 * via a small driver script). Telemetry comes back from the managed-agents
 * session API; feed it to `tests/evals/tool-ux-report.ts` for comparison.
 *
 * Two variants run per task:
 * - old: current tool surface (add_source / edit_source / remove_source /
 *        fetch_source / get_playbook / update_playbook_notes / list_categories)
 * - new: consolidated surface (manage_source, manage_playbook, no list_categories)
 *
 * Design notes:
 * - Tasks are phrased the way a human would — no explicit tool hints.
 * - Entities created by eval runs use the `eval-` prefix so cleanup is a
 *   predicate, not a bookkeeping exercise.
 * - Reversible-or-idempotent where possible so repeated runs converge.
 */

export interface ToolUxTask {
  /** Stable id used to correlate runs. */
  id: string;
  /** One-line summary for report headers. */
  label: string;
  /** The user message sent to the agent. No tool hints. */
  prompt: string;
  /**
   * Tools we'd expect a well-behaved agent to touch, for either variant.
   * Not enforced — used only to flag "wrong-tool" calls in the report.
   */
  expected: {
    old: string[];
    new: string[];
  };
  /**
   * Deterministic post-conditions the eval driver can verify against the DB
   * without an LLM judge. Omit for tasks where a response-level check is
   * enough — those go in `responseContains`.
   */
  dbCheck?: {
    kind:
      | "source_exists"
      | "source_priority"
      | "source_removed"
      | "org_exists"
      | "playbook_notes_contain"
      | "url_ignored"
      | "url_blocked";
    /** Identifiers referenced by the check — shape depends on `kind`. */
    args: Record<string, string>;
  };
  /** Substrings the final assistant message should contain (case-insensitive). */
  responseContains?: string[];
  /**
   * Cleanup hints for the driver. Tasks that create entities list the
   * predicates to delete after the run. Safe to ignore if running against a
   * throwaway DB snapshot.
   */
  cleanup?: Array<{
    kind: "delete_source" | "delete_org" | "unblock_url" | "unignore_url";
    args: Record<string, string>;
  }>;
}

export const TASKS: ToolUxTask[] = [
  // ── Add flow — exercises find → manage_source(add) ──────────────────
  {
    id: "add-source-to-existing-org",
    label: "Add a source under an existing org",
    prompt:
      "Add https://linear.app/changelog as a changelog source for Linear. Call it 'Linear Changelog'.",
    expected: {
      old: ["list_organizations", "add_source"],
      new: ["find", "manage_source"],
    },
    dbCheck: {
      kind: "source_exists",
      args: { url: "https://linear.app/changelog", orgSlug: "linear" },
    },
    cleanup: [
      { kind: "delete_source", args: { url: "https://linear.app/changelog", orgSlug: "linear" } },
    ],
  },

  // ── Add-with-autodetect — exercises manage_source(add) auto-evaluate ─
  // Old surface has to call evaluate_url first; new surface folds it in.
  {
    id: "add-source-auto-detect-type",
    label: "Add a source without specifying type",
    prompt:
      "There's a changelog at https://eval-autodetect.example/feed.xml for the Linear org. Add it — figure out the right source type yourself.",
    expected: {
      old: ["list_organizations", "evaluate_url", "add_source"],
      new: ["find", "manage_source"],
    },
    // No dbCheck — this URL is fictional and will fail evaluation; we're
    // measuring tool-call flow, not ingestion success.
    responseContains: ["feed", "eval-autodetect"],
  },

  // ── Edit flow — exercises find → manage_source(edit) ────────────────
  {
    id: "pause-source-fetching",
    label: "Change fetch priority on an existing source",
    prompt: "Pause fetching for the Vercel changelog source. Don't remove it, just pause it.",
    expected: {
      old: ["list_sources", "edit_source"],
      new: ["find", "manage_source"],
    },
    dbCheck: {
      kind: "source_priority",
      args: { sourceSlug: "vercel-changelog", priority: "paused" },
    },
    cleanup: [
      // Revert to normal after the run.
      { kind: "delete_source", args: { note: "driver should restore priority=normal" } },
    ],
  },

  // ── Remove flow — exercises find → manage_source(remove) ────────────
  {
    id: "remove-eval-source",
    label: "Remove a source by slug",
    prompt:
      "Remove the source with slug 'eval-cleanup-source' — it was added by mistake. If it doesn't exist, say so.",
    expected: {
      old: ["list_sources", "remove_source"],
      new: ["find", "manage_source"],
    },
    // Driver should seed this source before the run.
    dbCheck: {
      kind: "source_removed",
      args: { sourceSlug: "eval-cleanup-source" },
    },
  },

  // ── Org create + source add — multi-step onboarding ─────────────────
  {
    id: "onboard-new-org",
    label: "Create a new org and its first source",
    prompt:
      "Set up a new organization called 'Eval Test Corp' (domain eval-testcorp.example) in the 'developer-tools' category, and add https://eval-testcorp.example/changelog as its primary changelog source.",
    expected: {
      old: ["list_categories", "manage_org", "add_source", "edit_source"],
      new: ["manage_org", "manage_source"],
    },
    dbCheck: {
      kind: "org_exists",
      args: { slug: "eval-test-corp", category: "developer-tools" },
    },
    cleanup: [
      { kind: "delete_source", args: { url: "https://eval-testcorp.example/changelog" } },
      { kind: "delete_org", args: { slug: "eval-test-corp" } },
    ],
  },

  // ── Playbook workflow — exercises read-then-write on playbook notes ─
  {
    id: "append-playbook-note",
    label: "Add an observation to an org playbook",
    prompt:
      "Add a note to the Vercel playbook: their RSS feed truncates at 10 items, so crawl mode is needed for deeper history. Preserve any existing notes.",
    expected: {
      old: ["get_playbook", "update_playbook_notes"],
      new: ["manage_playbook"],
    },
    dbCheck: {
      kind: "playbook_notes_contain",
      args: { orgSlug: "vercel", substring: "truncates at 10 items" },
    },
    // Cleanup: restore prior notes. Driver snapshots notes before the run.
  },

  // ── Block + ignore — exercises exclude_url ──────────────────────────
  {
    id: "block-spam-domain",
    label: "Block an aggregator domain globally",
    prompt:
      "Block the domain eval-spam-aggregator.example globally — it's a content farm republishing changelogs. Use the whole-domain form, not the exact URL.",
    expected: {
      old: ["exclude_url"],
      new: ["exclude_url"],
    },
    dbCheck: {
      kind: "url_blocked",
      args: { pattern: "eval-spam-aggregator.example", type: "domain" },
    },
    cleanup: [{ kind: "unblock_url", args: { pattern: "eval-spam-aggregator.example" } }],
  },

  {
    id: "ignore-per-org-url",
    label: "Ignore a URL for one org only",
    prompt:
      "Ignore https://vercel.com/blog/eval-ignored-post for the Vercel org — it's a marketing post, not a release.",
    expected: {
      old: ["list_organizations", "exclude_url"],
      new: ["find", "exclude_url"],
    },
    dbCheck: {
      kind: "url_ignored",
      args: { url: "https://vercel.com/blog/eval-ignored-post", orgSlug: "vercel" },
    },
    cleanup: [
      {
        kind: "unignore_url",
        args: { url: "https://vercel.com/blog/eval-ignored-post", orgSlug: "vercel" },
      },
    ],
  },
];
