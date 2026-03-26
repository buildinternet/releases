// src/agent/mcp-cloudflare-browser.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const CF_REJECT_RESOURCE_TYPES = ["image", "media", "font", "stylesheet"];

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(1);
}

const server = new McpServer({
  name: "cloudflare-browser",
  version: "1.0.0",
});

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
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        rejectResourceTypes: CF_REJECT_RESOURCE_TYPES,
        gotoOptions: { waitUntil },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }],
        isError: true,
      };
    }

    const data = (await res.json()) as { title?: string; markdown?: string; text?: string };
    const markdown = data.markdown ?? data.text ?? "";

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ markdown, title: data.title ?? "", url }, null, 2),
        },
      ],
    };
  },
);

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
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        rejectResourceTypes: CF_REJECT_RESOURCE_TYPES,
        gotoOptions: { waitUntil },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        content: [{ type: "text" as const, text: `Error ${res.status}: ${body}` }],
        isError: true,
      };
    }

    const html = await res.text();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ html: html.slice(0, 50000), url }, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
