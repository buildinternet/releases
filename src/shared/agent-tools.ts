/**
 * Typed tool definitions and executor for managed agents.
 *
 * Replaces the string-parsing http-executor with structured tool schemas
 * and a typed dispatcher that maps tool calls directly to REST API endpoints.
 *
 * Shared between:
 * - CLI path (src/agent/managed-discovery.ts)
 * - Worker path (workers/discovery/src/managed-agents-session.ts)
 */

import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { assemblePlaybook } from "@releases/ai-internal/playbook";

// ── Tool input types ─────────────────────────────────────────────────
// Read tools (list_sources, list_organizations, get_latest_releases,
// search_releases, summarize_changes, compare_products) are provided by the
// MCP server at mcp.releases.sh via vault credentials. Only write, utility,
// and session tools remain as custom tools here.

export interface AddSourceInput {
  name: string;
  url: string;
  type?: "github" | "scrape" | "feed" | "agent";
  organization?: string;
  feed_url?: string;
}

export interface EditSourceInput {
  /** Source ID (src_...) or slug */
  identifier: string;
  is_primary?: boolean;
  fetch_priority?: "normal" | "low" | "paused";
  name?: string;
  url?: string;
  type?: "github" | "scrape" | "feed" | "agent";
}

export interface RemoveSourceInput {
  /** Source ID (src_...) or slug */
  identifier: string;
}

export interface FetchSourceInput {
  /** Source ID (src_...) or slug */
  identifier: string;
}

export interface ManageOrgInput {
  action: "add" | "edit" | "tag_add" | "link_account";
  /** Required for add */
  name?: string;
  /** Identifier for edit/tag_add/link_account — slug, domain, or name */
  identifier?: string;
  domain?: string;
  description?: string;
  category?: string;
  tags?: string[];
  /** For link_account */
  platform?: string;
  handle?: string;
}

export interface ManageProductInput {
  action: "add" | "edit" | "tag_add";
  /** Required for add */
  name?: string;
  /** Organization ID (org_...) or slug — required for add */
  organization?: string;
  /** Product ID (prod_...) or slug — required for edit/tag_add */
  identifier?: string;
  url?: string;
  description?: string;
  category?: string;
  tags?: string[];
}

export interface EvaluateUrlInput {
  url: string;
}

export interface ExcludeUrlInput {
  action: "ignore" | "block";
  url: string;
  /** Required for ignore */
  organization?: string;
  reason?: string;
  /** For block: "exact" or "domain" */
  block_type?: "exact" | "domain";
}

export interface GetPlaybookInput {
  organization: string;
}

export interface UpdatePlaybookNotesInput {
  organization: string;
  notes: string;
}

export interface ReportStateInput {
  state: Record<string, unknown>;
}

// Discriminated union for executor dispatch (custom tools only — reads via MCP)
export type AgentToolCall =
  | { tool: "add_source"; input: AddSourceInput }
  | { tool: "edit_source"; input: EditSourceInput }
  | { tool: "remove_source"; input: RemoveSourceInput }
  | { tool: "fetch_source"; input: FetchSourceInput }
  | { tool: "manage_org"; input: ManageOrgInput }
  | { tool: "manage_product"; input: ManageProductInput }
  | { tool: "evaluate_url"; input: EvaluateUrlInput }
  | { tool: "exclude_url"; input: ExcludeUrlInput }
  | { tool: "get_playbook"; input: GetPlaybookInput }
  | { tool: "update_playbook_notes"; input: UpdatePlaybookNotesInput }
  | { tool: "list_categories"; input: Record<string, never> }
  | { tool: "releases_report_state"; input: ReportStateInput };

// ── Anthropic tool schemas ───────────────────────────────────────────

/** Tool definitions in Anthropic custom tool format, for agent/environment registration. */
export const AGENT_TOOLS = [
  { type: "agent_toolset_20260401", default_config: { enabled: true } },

  // ── Read tools ──
  // Most read tools (list_sources, list_organizations, get_latest_releases,
  // search_releases, summarize_changes, compare_products) are provided by
  // the MCP server via vault credentials. Only list_categories remains here
  // because it's hardcoded and not backed by the MCP server.

  {
    type: "custom",
    name: "list_categories",
    description: "List valid category values for organizations and products.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },

  {
    type: "custom",
    name: "get_playbook",
    description:
      "Get the playbook for an organization. The playbook has two parts: an auto-generated header (source metadata, types, priorities, parseInstructions) and agent notes (free-form markdown you can edit). Read this before fetching or working with an org's sources. Returns null if no playbook exists yet (one will be auto-generated after the first source mutation). To change source configuration like parseInstructions, use edit_source — the header updates automatically.",
    input_schema: {
      type: "object" as const,
      properties: {
        organization: { type: "string", description: "Organization ID (org_...) or slug" },
      },
      required: ["organization"],
    },
  },
  {
    type: "custom",
    name: "update_playbook_notes",
    description:
      "Replace the agent notes section of an org's playbook. The notes section is free-form markdown that you fully control — you can rewrite, reorganize, or clear it. Use this to record observations about sources, content depth findings, feed quirks, filtering recommendations, or anything that helps future agents work with this org's sources. Pass the complete notes content (not a diff).",
    input_schema: {
      type: "object" as const,
      properties: {
        organization: { type: "string", description: "Organization ID (org_...) or slug" },
        notes: {
          type: "string",
          description:
            "Complete markdown content for the agent notes section. Replaces existing notes entirely.",
        },
      },
      required: ["organization", "notes"],
    },
  },

  // ── Write tools ──

  {
    type: "custom",
    name: "add_source",
    description:
      "Add a new changelog source. Type is auto-detected from URL if omitted (GitHub URLs → github, others → scrape).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Display name for the source" },
        url: { type: "string", description: "URL of the changelog source" },
        type: {
          type: "string",
          enum: ["github", "scrape", "feed", "agent"],
          description: "Source type (auto-detected if omitted)",
        },
        organization: { type: "string", description: "Organization ID (org_...) or slug" },
        feed_url: { type: "string", description: "Direct feed URL if known" },
      },
      required: ["name", "url"],
    },
  },
  {
    type: "custom",
    name: "edit_source",
    description: "Edit an existing changelog source's configuration.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: { type: "string", description: "Source ID (src_...) or slug" },
        is_primary: { type: "boolean", description: "Mark as primary source for its org" },
        fetch_priority: {
          type: "string",
          enum: ["normal", "low", "paused"],
          description: "Fetch priority tier",
        },
        name: { type: "string", description: "New display name" },
        url: { type: "string", description: "New URL" },
        type: {
          type: "string",
          enum: ["github", "scrape", "feed", "agent"],
          description: "New source type",
        },
      },
      required: ["identifier"],
    },
  },
  {
    type: "custom",
    name: "remove_source",
    description: "Remove a changelog source and all its releases.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: { type: "string", description: "Source ID (src_...) or slug" },
      },
      required: ["identifier"],
    },
  },
  {
    type: "custom",
    name: "fetch_source",
    description:
      "Trigger a fetch for a source to pull its latest releases. For feed/GitHub sources, fetches server-side. For scrape/agent sources, runs the full pipeline (render → parse → insert) in managed agent sessions, or flags for CLI pickup otherwise.",
    input_schema: {
      type: "object" as const,
      properties: {
        identifier: { type: "string", description: "Source ID (src_...) or slug" },
      },
      required: ["identifier"],
    },
  },
  {
    type: "custom",
    name: "manage_org",
    description:
      "Create or modify an organization. Actions: add (create new), edit (update fields), tag_add (add tags), link_account (link a platform account like GitHub or Twitter).",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "edit", "tag_add", "link_account"],
          description: "Operation to perform",
        },
        name: { type: "string", description: "Org name (required for add)" },
        identifier: {
          type: "string",
          description: "Organization ID (org_...), slug, domain, or name",
        },
        domain: { type: "string", description: "Primary domain (e.g. vercel.com)" },
        description: { type: "string", description: "Brief one-sentence product description" },
        category: { type: "string", description: "Category slug" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add" },
        platform: {
          type: "string",
          description: "Platform name for link_account (github, x, linkedin, etc.)",
        },
        handle: { type: "string", description: "Account handle for link_account" },
      },
      required: ["action"],
    },
  },
  {
    type: "custom",
    name: "manage_product",
    description:
      "Create or modify a product (grouping layer under an organization). Actions: add (create new), edit (update fields), tag_add (add tags).",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["add", "edit", "tag_add"],
          description: "Operation to perform",
        },
        name: { type: "string", description: "Product name (required for add)" },
        organization: {
          type: "string",
          description: "Organization ID (org_...) or slug (required for add)",
        },
        identifier: {
          type: "string",
          description: "Product ID (prod_...) or slug (required for edit, tag_add)",
        },
        url: { type: "string", description: "Canonical product URL" },
        description: { type: "string", description: "Brief product description" },
        category: { type: "string", description: "Category slug" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to add" },
      },
      required: ["action"],
    },
  },

  // ── Utility tools ──

  {
    type: "custom",
    name: "evaluate_url",
    description:
      "Evaluate a changelog URL to determine the best ingestion method. Returns provider detection, feed discovery, and recommended source type.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to evaluate" },
      },
      required: ["url"],
    },
  },
  {
    type: "custom",
    name: "exclude_url",
    description:
      "Ignore a URL for a specific org (prevents re-discovery) or globally block a URL/domain (spam, aggregators).",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["ignore", "block"],
          description: "ignore = org-scoped, block = global",
        },
        url: { type: "string", description: "URL or domain to exclude" },
        organization: { type: "string", description: "Org slug (required for ignore)" },
        reason: { type: "string", description: "Why this URL is being excluded" },
        block_type: {
          type: "string",
          enum: ["exact", "domain"],
          description: "For block: exact URL or entire domain (default: exact)",
        },
      },
      required: ["action", "url"],
    },
  },

  // ── Session tool ──

  {
    type: "custom",
    name: "releases_report_state",
    description:
      "Report the final discovery state as JSON. Call this at the end of discovery instead of writing to a file.",
    input_schema: {
      type: "object" as const,
      properties: {
        state: {
          type: "object",
          description:
            "The complete discovery state JSON object with product, domain, sources, etc.",
        },
      },
      required: ["state"],
    },
  },
] as const;

/** Names of tools that are dispatched via the API (everything except report_state). */
export const API_TOOL_NAMES: string[] = AGENT_TOOLS.filter(
  (t): t is Extract<typeof t, { type: "custom" }> => t.type === "custom",
)
  .map((t) => t.name)
  .filter((n) => n !== "releases_report_state");

// ── Typed executor ───────────────────────────────────────────────────

export interface APIClientOptions {
  /** Fetcher — either a Cloudflare service binding or a plain fetch wrapper. */
  fetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  /** Bearer token for authenticated requests. */
  apiKey: string;
  /** Base URL prefix (default: "https://api" for service bindings). */
  baseUrl?: string;
  /** Session ID to attach to fetch log entries for agent session correlation. */
  sessionId?: string;
}

/**
 * Create a typed executor that maps structured tool calls to REST API calls.
 *
 * Returns a function that takes a tool name and input object, routes to the
 * correct API endpoint, and returns the response text. Returns null for
 * `releases_report_state` (handled by the session runner, not the executor).
 */
export function createTypedExecutor(opts: APIClientOptions) {
  const baseUrl = opts.baseUrl ?? "https://api";

  async function api(method: string, path: string, body?: object): Promise<string> {
    const url = `${baseUrl}/v1${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    };

    try {
      const res = await opts.fetcher.fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      if (!res.ok) {
        return `Error (HTTP ${res.status}): ${text}`;
      }
      return text || "(no output)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Execute a typed tool call. Returns the result text, or null if the tool
   * is `releases_report_state` (which is handled by the session runner).
   */
  return async (toolName: string, input: Record<string, unknown>): Promise<string | null> => {
    switch (toolName) {
      // ── Read tool (remaining — most reads served by MCP) ──

      case "list_categories": {
        return JSON.stringify({ categories: CATEGORIES });
      }

      case "get_playbook": {
        const org = String(input.organization ?? "");
        if (!org) return "Error: organization is required";
        const result = await api("GET", `/playbook?slug=${encodeURIComponent(org)}`);
        if (result === "null" || result.trim() === "null") {
          return `No playbook exists yet for "${org}". A playbook will be auto-generated when you add, edit, or remove a source for this org.`;
        }
        try {
          const data = JSON.parse(result);
          return assemblePlaybook(data.content ?? "", data.notes ?? null);
        } catch {
          return result;
        }
      }

      case "update_playbook_notes": {
        const org = String(input.organization ?? "");
        if (!org) return "Error: organization is required";
        if (input.notes === undefined) return "Error: notes is required";
        return api("PATCH", `/playbook/notes?slug=${encodeURIComponent(org)}`, {
          notes: String(input.notes),
        });
      }

      // ── Write tools ──

      case "add_source": {
        const body: Record<string, unknown> = {
          name: input.name,
          url: input.url,
        };
        if (input.type) body.type = input.type;
        else if (input.feed_url) body.type = "feed";
        if (input.organization) body.orgSlug = input.organization;
        if (input.feed_url) {
          body.metadata = JSON.stringify({ feedUrl: input.feed_url });
        }
        const result = await api("POST", "/sources", body);
        if (input.organization && !result.startsWith("Error")) {
          return (
            result +
            `\n\n[Playbook for "${input.organization}" has been auto-regenerated. Use get_playbook to review.]`
          );
        }
        return result;
      }

      case "edit_source": {
        const identifier = String(input.identifier ?? "");
        if (!identifier) return "Error: identifier is required";
        const body: Record<string, unknown> = {};
        if (input.is_primary !== undefined) body.isPrimary = input.is_primary;
        if (input.fetch_priority) body.fetchPriority = input.fetch_priority;
        if (input.name) body.name = input.name;
        if (input.url) body.url = input.url;
        if (input.type) body.type = input.type;
        const result = await api("PATCH", `/sources/${encodeURIComponent(identifier)}`, body);
        if (!result.startsWith("Error")) {
          return result + `\n\n[Playbook has been auto-regenerated to reflect this change.]`;
        }
        return result;
      }

      case "remove_source": {
        const identifier = String(input.identifier ?? "");
        if (!identifier) return "Error: identifier is required";
        const result = await api("DELETE", `/sources/${encodeURIComponent(identifier)}`);
        if (!result.startsWith("Error")) {
          return result + `\n\n[Playbook has been auto-regenerated to reflect this removal.]`;
        }
        return result;
      }

      case "fetch_source": {
        const identifier = String(input.identifier ?? "");
        if (!identifier) return "Error: identifier is required";
        const fetchPath = opts.sessionId
          ? `/sources/${encodeURIComponent(identifier)}/fetch?sessionId=${encodeURIComponent(opts.sessionId)}`
          : `/sources/${encodeURIComponent(identifier)}/fetch`;
        return api("POST", fetchPath);
      }

      case "manage_org": {
        const action = String(input.action ?? "");

        if (action === "add") {
          const body: Record<string, unknown> = { name: input.name };
          if (input.domain) body.domain = input.domain;
          if (input.description) body.description = input.description;
          if (input.category) body.category = input.category;
          if (input.tags) body.tags = input.tags;
          return api("POST", "/orgs", body);
        }

        if (action === "edit") {
          const slug = String(input.identifier ?? "");
          if (!slug) return "Error: identifier is required for edit";
          const body: Record<string, unknown> = {};
          if (input.name) body.name = input.name;
          if (input.domain) body.domain = input.domain;
          if (input.description) body.description = input.description;
          if (input.category) body.category = input.category;
          return api("PATCH", `/orgs/${encodeURIComponent(slug)}`, body);
        }

        if (action === "tag_add") {
          const slug = String(input.identifier ?? "");
          if (!slug) return "Error: identifier is required for tag_add";
          if (!input.tags || !Array.isArray(input.tags)) return "Error: tags array is required";
          return api("PUT", `/orgs/${encodeURIComponent(slug)}/tags`, { tags: input.tags });
        }

        if (action === "link_account") {
          const slug = String(input.identifier ?? "");
          if (!slug) return "Error: identifier is required for link_account";
          if (!input.platform || !input.handle) return "Error: platform and handle are required";
          return api("POST", `/orgs/${encodeURIComponent(slug)}/accounts`, {
            platform: input.platform,
            handle: input.handle,
          });
        }

        return `Error: unknown action "${action}"`;
      }

      case "manage_product": {
        const action = String(input.action ?? "");

        if (action === "add") {
          if (!input.name || !input.organization)
            return "Error: name and organization are required for add";
          const body: Record<string, unknown> = { orgSlug: input.organization, name: input.name };
          if (input.identifier) body.slug = input.identifier;
          if (input.url) body.url = input.url;
          if (input.description) body.description = input.description;
          if (input.category) body.category = input.category;
          if (input.tags) body.tags = input.tags;
          return api("POST", "/products", body);
        }

        if (action === "edit") {
          const identifier = String(input.identifier ?? "");
          if (!identifier) return "Error: identifier is required for edit";
          const body: Record<string, unknown> = {};
          if (input.name) body.name = input.name;
          if (input.url) body.url = input.url;
          if (input.description) body.description = input.description;
          if (input.category) body.category = input.category;
          return api("PATCH", `/products/${encodeURIComponent(identifier)}`, body);
        }

        if (action === "tag_add") {
          const identifier = String(input.identifier ?? "");
          if (!identifier) return "Error: identifier is required for tag_add";
          if (!input.tags || !Array.isArray(input.tags)) return "Error: tags array is required";
          return api("PUT", `/products/${encodeURIComponent(identifier)}/tags`, {
            tags: input.tags,
          });
        }

        return `Error: unknown action "${action}"`;
      }

      // ── Utility tools ──

      case "evaluate_url": {
        const url = String(input.url ?? "");
        if (!url) return "Error: url is required";
        return api("GET", `/evaluate?url=${encodeURIComponent(url)}`);
      }

      case "exclude_url": {
        const action = String(input.action ?? "");
        const url = String(input.url ?? "");
        if (!url) return "Error: url is required";

        if (action === "ignore") {
          const org = String(input.organization ?? "");
          if (!org) return "Error: organization is required for ignore";
          const body: Record<string, unknown> = { url };
          if (input.reason) body.reason = input.reason;
          return api("POST", `/orgs/${encodeURIComponent(org)}/ignored-urls`, body);
        }

        if (action === "block") {
          const body: Record<string, unknown> = { pattern: url };
          if (input.block_type) body.type = input.block_type;
          if (input.reason) body.reason = input.reason;
          return api("POST", "/blocked-urls", body);
        }

        return `Error: unknown action "${action}"`;
      }

      // ── Session tool (handled by caller) ──

      case "releases_report_state":
        return null;

      default:
        return `Error: unknown tool "${toolName}"`;
    }
  };
}

// ── Shared tool dispatch helper ──────────────────────────────────────

const MAX_TOOL_OUTPUT = 50_000;

export interface ToolDispatchContext {
  /** Send a tool result back to the Anthropic session. */
  sendResult: (toolUseId: string, text: string) => Promise<void>;
  /** Typed executor for API-proxied tools. */
  executor: ReturnType<typeof createTypedExecutor>;
  /** Called on state capture (onboard mode). */
  onStateCapture?: (state: Record<string, unknown>) => void;
  /** Called when an API tool is dispatched. */
  onToolCall?: (toolName: string, input: Record<string, unknown>) => void;
  /**
   * Optional handler for scrape source fetches. When provided and fetch_source
   * returns a "flagged" response, this handler is called to do the actual
   * scrape (Cloudflare render → AI parse → insert). Returns the result string
   * to send back to the agent.
   */
  onScrapeFetch?: (sourceIdentifier: string) => Promise<string>;
}

/**
 * Handle an `agent.custom_tool_use` event from a managed agent session.
 *
 * Returns true if the event was a `releases_report_state` call (caller may
 * want to `continue` instead of `break`), false otherwise.
 */
export async function handleCustomToolUse(
  event: { id: string; name: string; input?: Record<string, unknown> },
  ctx: ToolDispatchContext,
): Promise<boolean> {
  const { name: toolName, input: toolInput = {}, id: toolUseId } = event;

  if (toolName === "releases_report_state") {
    const reported = toolInput.state;
    if (reported && typeof reported === "object") {
      const state = reported as Record<string, unknown>;
      state["updatedAt"] = new Date().toISOString();
      ctx.onStateCapture?.(state);
    }
    await ctx.sendResult(toolUseId, "State captured successfully.");
    return true;
  }

  if (API_TOOL_NAMES.includes(toolName)) {
    ctx.onToolCall?.(toolName, toolInput);
    let result = await ctx.executor(toolName, toolInput);

    // When fetch_source returns "flagged" and a scrape handler is available,
    // run the actual scrape pipeline instead of just reporting the flag.
    if (toolName === "fetch_source" && ctx.onScrapeFetch) {
      const isFlagged = (() => {
        try {
          return JSON.parse(result ?? "{}").type === "flagged";
        } catch {
          return false;
        }
      })();
      if (isFlagged) {
        const identifier = String(toolInput.identifier ?? "");
        try {
          result = await ctx.onScrapeFetch(identifier);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = `Scrape fetch failed: ${msg}`;
        }
      }
    }

    const output = result ?? "(no output)";
    const truncated =
      output.length > MAX_TOOL_OUTPUT
        ? output.slice(0, MAX_TOOL_OUTPUT) + `\n\n[output truncated — ${output.length} total chars]`
        : output;
    await ctx.sendResult(toolUseId, truncated);
    return false;
  }

  await ctx.sendResult(toolUseId, `Unknown tool: ${toolName}`);
  return false;
}
