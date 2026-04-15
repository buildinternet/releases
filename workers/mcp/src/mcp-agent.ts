import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDb } from "./db.js";
import Anthropic from "@anthropic-ai/sdk";
import { hydrateMediaUrls } from "@releases/lib/media-url.js";
import {
  searchReleases,
  getLatestReleases,
  listSources,
  listOrganizations,
  getOrganization,
  getSourceChangelog,
  getRelease,
  getSource,
  listProducts,
  getProduct,
  summarizeChanges,
  compareProducts,
} from "./tools.js";

type SecretBinding = { get(): Promise<string> };

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: SecretBinding;
  ENABLE_AI_TOOLS?: string;
  MEDIA_ORIGIN?: string;
}

export function createServer(env: Env) {
  const server = new McpServer({
    name: "releases",
    version: "0.10.0",
  });

  const db = createDb(env.DB);
  const mediaOrigin = env.MEDIA_ORIGIN ?? "";

  /** Hydrate portable /_media/ URLs in tool text output. */
  type ToolResult = { content: [{ type: "text"; text: string }] };
  function withMedia<T>(handler: (params: T) => Promise<ToolResult>) {
    return async (params: T): Promise<ToolResult> => {
      const result = await handler(params);
      if (mediaOrigin && result.content[0]?.text) {
        result.content[0].text = hydrateMediaUrls(result.content[0].text, mediaOrigin);
      }
      return result;
    };
  }

  // Lazily resolve the Anthropic client once per server instance
  let anthropicClient: Anthropic | undefined;
  async function getAnthropic(): Promise<Anthropic> {
    if (!anthropicClient) {
      const apiKey = await env.ANTHROPIC_API_KEY.get();
      anthropicClient = new Anthropic({ apiKey });
    }
    return anthropicClient;
  }

  server.registerTool("search_releases", {
    description: "Full-text search across all indexed release notes",
    inputSchema: {
      query: z.string().describe("Search query"),
      product: z.string().optional().describe("Filter to a specific product slug"),
      organization: z.string().optional().describe("Filter to sources belonging to this organization"),
      type: z.enum(["feature", "rollup"]).optional().describe("Filter by release type: 'feature' for individual releases, 'rollup' for seasonal/quarterly catch-all posts. Omit to include both."),
      limit: z.number().optional().describe("Max results to return (default 20)"),
    },
  }, withMedia(async (params) => searchReleases(db, params)));

  server.registerTool("get_latest_releases", {
    description: "Get the most recent releases, optionally filtered by product or organization",
    inputSchema: {
      product: z.string().optional().describe("Filter to a specific product slug"),
      organization: z.string().optional().describe("Filter to sources belonging to this organization"),
      type: z.enum(["feature", "rollup"]).optional().describe("Filter by release type: 'feature' for individual releases, 'rollup' for seasonal/quarterly catch-all posts. Omit to include both."),
      count: z.number().optional().describe("Number of releases to return (default 10)"),
    },
  }, withMedia(async (params) => getLatestReleases(db, params)));

  server.registerTool("list_sources", {
    description: "List all indexed changelog sources",
    inputSchema: {
      organization: z.string().optional().describe("Filter to sources belonging to this organization"),
    },
  }, async (params) => listSources(db, params));

  server.registerTool("list_organizations", {
    description: "List all indexed organizations, optionally filtered",
    inputSchema: {
      query: z.string().optional().describe("Search across org name, slug, domain, and account handles"),
      platform: z.string().optional().describe("Filter to orgs with an account on this platform"),
    },
  }, async (params) => listOrganizations(db, params));

  server.registerTool("get_organization", {
    description: "Get detailed information about a single organization including accounts, tags, sources, products, and aliases",
    inputSchema: {
      identifier: z.string().describe("Organization slug, domain, name, or account handle"),
    },
  }, async (params) => getOrganization(db, params));

  server.registerTool("get_source", {
    description: "Detail for a single indexed source: organization, optional product linkage, release count (excluding suppressed), last-fetched timestamp, and whether a tracked CHANGELOG file is available for get_source_changelog. Use this after list_sources or search_releases when the user wants to understand one source in depth (e.g. 'tell me about the apollo-client source').",
    inputSchema: {
      identifier: z.string().describe("Source slug (e.g. 'apollo-client') or src_ id"),
    },
  }, async (params) => getSource(db, params));

  server.registerTool("get_source_changelog", {
    description: "Read a tracked CHANGELOG file for a GitHub source. Monorepos expose per-package files (e.g. `packages/next/CHANGELOG.md`) alongside the root CHANGELOG — pass `path` to read a specific one, omit it to get the root. Supports heading-aligned slicing by chars (`limit`) or by tokens (`tokens`, cl100k_base) for LLM context budgeting. Every response includes `totalTokens` for the whole file and, in token mode, `sliceTokens` for the returned chunk. Files over 1MB are truncated at fetch time; the response flags this so you know the tail is missing.",
    inputSchema: {
      source: z.string().describe("Source slug or ID (e.g. 'apollo-client' or 'src_...')"),
      path: z.string().optional().describe("Specific file path to read (e.g. 'packages/next/CHANGELOG.md'). Defaults to the root CHANGELOG."),
      offset: z.number().optional().describe("Character offset into the selected file. Snapped forward to the next heading unless 0."),
      limit: z.number().optional().describe("Target slice size in characters. The slice ends at a heading boundary. Defaults to 40000 when slicing without a token budget."),
      tokens: z.number().optional().describe("Target slice size in tokens (cl100k_base). Takes precedence over `limit`. Recommended brackets: 2000, 5000, 10000, 20000."),
    },
  }, withMedia(async (params) => getSourceChangelog(db, params)));

  server.registerTool("get_release", {
    description: "Fetch the full content of a single release by id. Release ids are returned by search_releases / get_latest_releases — pass them here to read the whole entry (e.g. to quote a specific Next.js release note). Accepts the full rel_<nanoid> form or the bare 21-char nanoid.",
    inputSchema: {
      id: z.string().describe("Release id — 'rel_<nanoid>' or a bare 21-char nanoid"),
    },
  }, withMedia(async (params) => getRelease(db, params)));

  server.registerTool("list_products", {
    description: "List products — the optional grouping layer between organizations and sources. Multi-product orgs (e.g. Vercel → Next.js, Turborepo) expose their lineup here. Pass an organization filter to scope to one org; omit it to see every indexed product.",
    inputSchema: {
      organization: z.string().optional().describe("Organization slug, domain, name, or org_ id (e.g. 'vercel')"),
    },
  }, async (params) => listProducts(db, params));

  server.registerTool("get_product", {
    description: "Detail for a single product including its organization, category, tags, and the sources grouped under it. Use when the user asks about a specific product (e.g. 'what sources does Next.js have?' on Vercel) rather than the whole organization.",
    inputSchema: {
      identifier: z.string().describe("Product slug (e.g. 'nextjs') or prod_ id"),
    },
  }, async (params) => getProduct(db, params));


  if (env.ENABLE_AI_TOOLS === "true") {
    server.registerTool("summarize_changes", {
      description: "Get an AI-generated summary of recent changes for a product",
      inputSchema: {
        product: z.string().describe("Product slug"),
        days: z.number().optional().describe("Look back this many days (default 30)"),
        instructions: z.string().optional().describe("Additional guidance for the summary (e.g. what to focus on, audience, format)"),
      },
    }, withMedia(async (params) => {
      const anthropic = await getAnthropic();
      return summarizeChanges(db, params, anthropic);
    }));

    server.registerTool("compare_products", {
      description: "Compare recent changes between two products",
      inputSchema: {
        products: z.array(z.string()).describe("Array of two product slugs to compare"),
        days: z.number().optional().describe("Look back this many days (default 30)"),
      },
    }, withMedia(async (params) => {
      const anthropic = await getAnthropic();
      return compareProducts(db, params, anthropic);
    }));
  }

  return server;
}
