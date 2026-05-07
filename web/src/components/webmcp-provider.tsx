"use client";

// In-browser WebMCP provider. Registers a read-only subset of the Releases MCP
// tools via `navigator.modelContext.registerTool()` so browser-side AI agents
// can query the registry without setting up a remote connection.
//
// Parity note: the same tools are also exposed over the remote MCP server
// (`workers/mcp/src/tools.ts`) and the local stdio MCP server (`src/mcp/server.ts`).
// When you add, rename, or change the signature of a read-only MCP tool in
// either of those, update this provider in the same PR so the three surfaces
// don't drift. Write/admin tools intentionally stay remote-only — the browser
// can't hold an API key safely.

import { useEffect } from "react";

interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, client?: unknown) => unknown | Promise<unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface ModelContext {
  registerTool: (
    tool: ModelContextTool,
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
}

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
}

export function WebMcpProvider({ apiBaseUrl }: { apiBaseUrl: string }) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.modelContext) return;

    const ctrl = new AbortController();
    const { signal } = ctrl;
    const mc = navigator.modelContext;
    const base = apiBaseUrl.replace(/\/$/, "");

    async function apiFetch(path: string): Promise<unknown> {
      const res = await fetch(`${base}${path}`, { signal });
      if (!res.ok) throw new Error(`releases.sh API error: ${res.status} ${res.statusText}`);
      return res.json();
    }

    mc.registerTool(
      {
        name: "search",
        title: "Search",
        description:
          "Unified search across organizations, the catalog (products + standalone sources), and release content on releases.sh. Returns a single envelope with `orgs`, `catalog`, `releases`, and `chunks` — use `catalog` entries' `kind: 'product' | 'source'` discriminator to branch on entry shape. Pass `domain` to scope to one org by domain (input is normalized, so `https://vercel.com/` works the same as `vercel.com`).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Free-text search query (product name, feature, keyword).",
            },
            domain: {
              type: "string",
              description:
                "Scope to the org owning this domain. Normalized server-side. Returns `domainStatus: 'not_found'` with empty arrays when nothing owns the domain.",
            },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const query = String(input.query ?? "").trim();
          const domain = input.domain ? String(input.domain).trim() : "";
          const limit = Number(input.limit ?? 20);
          if (!query) throw new Error("`query` is required");
          const qs = new URLSearchParams({ q: query, limit: String(limit) });
          if (domain) qs.set("domain", domain);
          return apiFetch(`/v1/search?${qs.toString()}`);
        },
      },
      { signal },
    );

    mc.registerTool(
      {
        name: "lookup_domain",
        title: "Lookup by domain",
        description:
          "Resolve a domain to the org or product that owns it on releases.sh. Input is normalized server-side (scheme, `www.`, path stripped, lowercased). Returns the matching org plus any products whose alias targets the domain. Pure resolution — unknown domains return a 404, no on-demand probing.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to resolve. Any URL-shaped form is accepted.",
            },
          },
          required: ["domain"],
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const domain = String(input.domain ?? "").trim();
          if (!domain) throw new Error("`domain` is required");
          return apiFetch(`/v1/lookups/by-domain?domain=${encodeURIComponent(domain)}`);
        },
      },
      { signal },
    );

    mc.registerTool(
      {
        name: "list_organizations",
        title: "List organizations",
        description:
          "List all organizations tracked in the releases.sh registry, with release counts and activity. Returns the canonical `{ items, pagination }` envelope so callers can ask for the next slice via `page`.",
        inputSchema: {
          type: "object",
          properties: {
            page: {
              type: "integer",
              minimum: 1,
              default: 1,
              description: "1-based page number. Defaults to 1.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              description: "Entries per page (1–500). Defaults to the API's page size.",
            },
          },
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const qs = new URLSearchParams();
          if (typeof input.page === "number" && input.page > 0) qs.set("page", String(input.page));
          if (typeof input.limit === "number" && input.limit > 0)
            qs.set("limit", String(input.limit));
          const suffix = qs.toString();
          return apiFetch(`/v1/orgs${suffix ? `?${suffix}` : ""}`);
        },
      },
      { signal },
    );

    mc.registerTool(
      {
        name: "get_organization",
        title: "Get organization",
        description:
          "Fetch detailed information about an organization, including its sources, products, and AI-generated overview. Accepts an `org_…` id, slug (e.g. 'vercel', 'anthropic'), domain, name, or account handle.",
        inputSchema: {
          type: "object",
          properties: {
            identifier: {
              type: "string",
              description: "Organization identifier: `org_…` id, slug, domain, name, or handle.",
            },
          },
          required: ["identifier"],
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const identifier = String(input.identifier ?? "").trim();
          if (!identifier) throw new Error("`identifier` is required");
          return apiFetch(`/v1/orgs/${encodeURIComponent(identifier)}`);
        },
      },
      { signal },
    );

    mc.registerTool(
      {
        name: "get_catalog_entry",
        title: "Get catalog entry",
        description:
          "Fetch a catalog entry by org-scoped identifier — accepts either a `<orgSlug>/<sourceSlug>` coordinate or a `src_…` ID. Returns recent releases alongside entry detail. Use after `search` or `list_organizations` to drill into a specific source — both surface the org slug and source slug you'll need here.",
        inputSchema: {
          type: "object",
          properties: {
            identifier: {
              type: "string",
              description: "Org-scoped identifier: `<orgSlug>/<sourceSlug>` or `src_<id>`.",
            },
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
          required: ["identifier"],
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const identifier = String(input.identifier ?? "").trim();
          const page = Number(input.page ?? 1);
          const pageSize = Number(input.pageSize ?? 20);
          if (!identifier) throw new Error("`identifier` is required");
          const qs = `?page=${page}&pageSize=${pageSize}`;
          // Typed source ID — the bare path keeps accepting these because IDs
          // are globally unique. Slug-form bare paths are deprecated (#698).
          if (identifier.startsWith("src_")) {
            return apiFetch(`/v1/sources/${encodeURIComponent(identifier)}${qs}`);
          }
          // Coordinate form `org/slug` — split into org-scoped path segments.
          const slash = identifier.indexOf("/");
          if (slash > 0 && slash < identifier.length - 1) {
            const orgSlug = identifier.slice(0, slash);
            const sourceSlug = identifier.slice(slash + 1);
            return apiFetch(
              `/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(sourceSlug)}${qs}`,
            );
          }
          // Bare slug — ambiguous since slugs are org-scoped (#690). Reject
          // with a hint that mirrors the server-side MCP tool (#706) so the
          // three surfaces present a consistent contract to LLM callers.
          throw new Error(
            `Bare slug "${identifier}" is ambiguous — source slugs are org-scoped. ` +
              `Use \`<orgSlug>/<sourceSlug>\` (e.g. "vercel/nextjs") or a \`src_…\` ID.`,
          );
        },
      },
      { signal },
    );

    mc.registerTool(
      {
        name: "get_release",
        title: "Get release",
        description:
          "Fetch a single release by ID (prefix 'rel_'), including its full content and metadata.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Release ID, e.g. 'rel_abc123'." },
          },
          required: ["id"],
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const id = String(input.id ?? "").trim();
          if (!id) throw new Error("`id` is required");
          return apiFetch(`/v1/releases/${encodeURIComponent(id)}`);
        },
      },
      { signal },
    );

    mc.registerTool(
      {
        name: "open_search_page",
        title: "Open search page",
        description:
          "Navigate the current browser tab to the releases.sh search results page for a query. Use when the user wants to browse results visually on the site.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
          },
          required: ["query"],
        },
        execute: async (input) => {
          const query = String(input.query ?? "").trim();
          if (!query) throw new Error("`query` is required");
          window.location.assign(`/search?q=${encodeURIComponent(query)}`);
          return { navigated: true, url: `/search?q=${encodeURIComponent(query)}` };
        },
      },
      { signal },
    );

    return () => ctrl.abort();
  }, [apiBaseUrl]);

  return null;
}
