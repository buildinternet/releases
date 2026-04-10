import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDb } from "./db.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  searchReleases,
  getLatestReleases,
  listSources,
  listOrganizations,
  getOrganization,
  summarizeChanges,
  compareProducts,
} from "./tools.js";

type SecretBinding = { get(): Promise<string> };

export interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: SecretBinding;
  ENABLE_AI_TOOLS?: string;
}

export function createServer(env: Env) {
  const server = new McpServer({
    name: "releases",
    version: "0.9.1",
  });

  const db = createDb(env.DB);

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
      limit: z.number().optional().describe("Max results to return (default 20)"),
    },
  }, async (params) => searchReleases(db, params));

  server.registerTool("get_latest_releases", {
    description: "Get the most recent releases, optionally filtered by product or organization",
    inputSchema: {
      product: z.string().optional().describe("Filter to a specific product slug"),
      organization: z.string().optional().describe("Filter to sources belonging to this organization"),
      count: z.number().optional().describe("Number of releases to return (default 10)"),
    },
  }, async (params) => getLatestReleases(db, params));

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

  if (env.ENABLE_AI_TOOLS === "true") {
    server.registerTool("summarize_changes", {
      description: "Get an AI-generated summary of recent changes for a product",
      inputSchema: {
        product: z.string().describe("Product slug"),
        days: z.number().optional().describe("Look back this many days (default 30)"),
        instructions: z.string().optional().describe("Additional guidance for the summary (e.g. what to focus on, audience, format)"),
      },
    }, async (params) => {
      const anthropic = await getAnthropic();
      return summarizeChanges(db, params, anthropic);
    });

    server.registerTool("compare_products", {
      description: "Compare recent changes between two products",
      inputSchema: {
        products: z.array(z.string()).describe("Array of two product slugs to compare"),
        days: z.number().optional().describe("Look back this many days (default 30)"),
      },
    }, async (params) => {
      const anthropic = await getAnthropic();
      return compareProducts(db, params, anthropic);
    });
  }

  return server;
}
