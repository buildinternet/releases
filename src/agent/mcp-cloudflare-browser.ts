import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { CF_REJECT_RESOURCE_TYPES } from "../adapters/cloudflare.js";
import { config } from "@releases/lib/config";

const accountId = config.cloudflareAccountId();
const apiToken = config.cloudflareApiToken();

if (!accountId || !apiToken) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(1);
}

const server = new McpServer({
  name: "cloudflare-browser",
  version: "1.0.0",
});

const HTML_MAX_LENGTH = 50_000;

async function cfBrowserFetch(path: string, url: string, waitUntil: string): Promise<Response> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${path}`;
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      rejectResourceTypes: [...CF_REJECT_RESOURCE_TYPES],
      gotoOptions: { waitUntil },
    }),
  });
}

function errorResult(status: number, body: string) {
  return {
    content: [{ type: "text" as const, text: `Error ${status}: ${body}` }],
    isError: true,
  };
}

server.registerTool("render_markdown", {
  description: "Render a URL via Cloudflare Browser Rendering and return the page content as markdown. Use this when WebFetch returns empty or skeleton content from JS-rendered pages.",
  inputSchema: {
    url: z.url().describe("The URL to render"),
    waitUntil: z
      .enum(["load", "networkidle2"])
      .default("networkidle2")
      .describe("When to consider the page loaded"),
  },
}, async ({ url, waitUntil }) => {
  const res = await cfBrowserFetch("markdown", url, waitUntil);

  if (!res.ok) return errorResult(res.status, await res.text());

  const data = (await res.json()) as { title?: string; markdown?: string; text?: string };
  const markdown = data.markdown ?? data.text ?? "";

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ markdown, title: data.title ?? "", url }),
    }],
  };
});

server.registerTool("render_html", {
  description: "Render a URL and return the fully-rendered HTML after JavaScript execution. Use when you need to inspect the post-hydration DOM structure.",
  inputSchema: {
    url: z.url().describe("The URL to render"),
    waitUntil: z
      .enum(["load", "networkidle2"])
      .default("networkidle2")
      .describe("When to consider the page loaded"),
  },
}, async ({ url, waitUntil }) => {
  const res = await cfBrowserFetch("content", url, waitUntil);

  if (!res.ok) return errorResult(res.status, await res.text());

  const html = await res.text();
  const truncated = html.length > HTML_MAX_LENGTH;

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ html: truncated ? html.slice(0, HTML_MAX_LENGTH) : html, url, truncated }),
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
