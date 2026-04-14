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
    version: "0.9.1",
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

  server.registerTool("get_source_changelog", {
    description: "Read the canonical CHANGELOG.md file tracked for a GitHub source. Supports heading-aligned slicing — pass offset/limit to read a range of characters, and chain successive calls via the returned next offset to page through large files (e.g. Apollo Client's 700KB CHANGELOG). Omit both params to get the first 40k characters.",
    inputSchema: {
      source: z.string().describe("Source slug or ID (e.g. 'apollo-client' or 'src_...')"),
      offset: z.number().optional().describe("Character offset into the full file. Snapped forward to the next heading unless 0."),
      limit: z.number().optional().describe("Target slice size in characters. The slice ends at a heading boundary; defaults to 40000 when slicing."),
    },
  }, withMedia(async (params) => getSourceChangelog(db, params)));

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
