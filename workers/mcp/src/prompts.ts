import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import type { D1Db } from "./db.js";
import { completeOrgSlug, completeProductSlug } from "./slug-completion.js";

/**
 * Prompts are user-triggered conversation starters. Each returns a single
 * priming message — the client's LLM then calls the actual tools. We keep the
 * prompt body short and explicit about which tools to use so models that don't
 * auto-plan well still land on the right call.
 */

/**
 * MCP prompt arguments arrive as strings (per spec). Coerce the `days`
 * look-back to a positive integer; fall back to the prompt's default when
 * missing, NaN, or non-positive so the interpolated tool call always embeds
 * a valid number.
 */
function parseDays(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Quote user-controlled strings so the interpolated snippet stays parseable. */
const q = (value: string): string => JSON.stringify(value);

export function registerPrompts(server: McpServer, db: D1Db, opts: { aiTools: boolean }) {
  server.registerPrompt(
    "whats_new",
    {
      title: "What's new in a product",
      description:
        "Summarize recent changes for a product over the last N days. Uses the product's indexed releases.",
      argsSchema: {
        product: completable(
          z.string().describe("Product slug (e.g. 'nextjs', 'supabase-studio')"),
          (value) => completeProductSlug(db, value),
        ),
        days: z.string().optional().describe("Look-back window in days (default 30)"),
      },
    },
    async ({ product, days }) => {
      const window = parseDays(days, 30);
      const tool = opts.aiTools
        ? `Use the \`summarize_changes\` tool with product=${q(product)} and days=${window} to generate an AI summary.`
        : `Call \`get_latest_releases\` with product=${q(product)} (request enough entries to cover the last ${window} days) and summarize the highlights yourself.`;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `What's new in ${product} over the last ${window} days? ${tool} Group the result into themes (new features, fixes, breaking changes) and cite release titles or versions when possible.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "compare_products",
    {
      title: "Compare two products",
      description:
        "Compare recent releases between two products to surface divergence and overlap in features, fixes, and breaking changes.",
      argsSchema: {
        productA: completable(z.string().describe("First product slug"), (value) =>
          completeProductSlug(db, value),
        ),
        productB: completable(z.string().describe("Second product slug"), (value) =>
          completeProductSlug(db, value),
        ),
        days: z.string().optional().describe("Look-back window in days (default 30)"),
      },
    },
    async ({ productA, productB, days }) => {
      const window = parseDays(days, 30);
      const tool = opts.aiTools
        ? `Use the \`compare_products\` tool with products=[${q(productA)}, ${q(productB)}] and days=${window}.`
        : `Call \`get_latest_releases\` twice — once per product — over the last ${window} days, then do the comparison yourself.`;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Compare recent changes between ${productA} and ${productB} over the last ${window} days. ${tool} Highlight where they overlap, where they diverge, and any breaking changes on either side.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "catch_me_up",
    {
      title: "Catch me up on an organization",
      description:
        "Pull the AI-generated overview for an org plus its most recent releases — a quick status briefing.",
      argsSchema: {
        organization: completable(
          z.string().describe("Organization slug, domain, or name"),
          (value) => completeOrgSlug(db, value),
        ),
        days: z
          .string()
          .optional()
          .describe("Look-back window in days for recent releases (default 14)"),
      },
    },
    async ({ organization, days }) => {
      const window = parseDays(days, 14);
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Catch me up on ${organization}. First call \`get_organization\` with identifier=${q(organization)} and include_overview: true to read the narrative briefing. Then call \`get_latest_releases\` with organization=${q(organization)} and enough entries to cover the last ${window} days. Present the overview first, then a chronological list of the recent releases grouped by product.`,
            },
          },
        ],
      };
    },
  );
}
