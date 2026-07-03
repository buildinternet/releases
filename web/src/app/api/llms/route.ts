import { adminDocs } from "@/flags";
import { CLAUDE_CODE_MCP_CMD, MCP_REMOTE_URL } from "@/lib/agent-launch";
import { getStaticBaseUrl } from "@/lib/base-url";
import {
  docsManifest,
  groupBySection,
  SITE_NAME,
  SITE_TAGLINE,
  type DocEntry,
} from "@/lib/docs-manifest";

const BASE_URL = getStaticBaseUrl();
const API_BASE_URL = "https://api.releases.sh";

// llms.txt (https://llmstxt.org): H1 → one-paragraph blockquote summary →
// freeform context (no headings) → H2 link sections, with `## Optional` last
// for links safe to skip on a tight context budget. The docs sections are
// generated from the manifest so they can't drift from the sidebar;
// everything else is static.

const SUMMARY = `${SITE_TAGLINE} Releases tracks release notes, changelogs, and version updates across hundreds of developer tools and services, normalizes them into one registry, and serves them over a REST API, a hosted MCP server, an open-source CLI, and this site. Most reads are public — no account or API key required.`;

const CONTEXT = `Quick facts:

- REST API base URL: \`${API_BASE_URL}/v1\`. OpenAPI 3.1 spec: ${API_BASE_URL}/v1/openapi.json. Interactive reference: ${API_BASE_URL}/v1/docs.
- Hosted MCP server (Streamable HTTP, read tools public, no key): \`${MCP_REMOTE_URL}\`. Claude Code: \`${CLAUDE_CODE_MCP_CMD}\`.
- CLI: \`npm install -g @buildinternet/releases\` (or \`brew install buildinternet/tap/releases\`). Agent skills: \`npx skills add buildinternet/releases-cli\`.
- Links below point to Markdown versions of each page. Any page on this site is also available as Markdown by appending \`.md\` to its URL (for example, ${BASE_URL}/docs/installation.md) or by sending \`Accept: text/markdown\` to the canonical URL.
- Org and source pages have machine-readable suffixes — \`.md\` (LLM-friendly), \`.json\`, \`.atom\` — e.g. ${BASE_URL}/anthropic.md.`;

const MACHINE_ENDPOINTS = `## Machine-readable endpoints

- [OpenAPI 3.1 spec](${API_BASE_URL}/v1/openapi.json): Every public REST endpoint's request and response shapes — the source of truth.
- [Agent authentication guide](${BASE_URL}/auth.md): OAuth 2.0 / OIDC discovery and token how-to for the few write paths; public reads need none.
- [MCP server card](${BASE_URL}/.well-known/mcp/server-card.json): Machine-readable description of the hosted MCP server.
- [Agent skills index](${BASE_URL}/.well-known/agent-skills/index.json): Discovery document for the installable agent skills.
- [API catalog](${BASE_URL}/.well-known/api-catalog): RFC 9727 catalog advertising the REST API.
- [releases.json schema](${BASE_URL}/schemas/releases.json): JSON Schema for owner-declared listing metadata (see Get Listed above).`;

const OPTIONAL = `## Optional

- [llms-full.txt](${BASE_URL}/llms-full.txt): All documentation pages concatenated into one file, for single-context ingestion.
- [CLI source repository](https://github.com/buildinternet/releases-cli): The open-source CLI, agent skills, and Claude Code plugins.
- [MCP Registry listing](https://registry.modelcontextprotocol.io/v0.1/servers?search=sh.releases/mcp): The hosted server's entry in the official MCP Registry (\`sh.releases/mcp\`).`;

function line(entry: DocEntry): string {
  const url = `${BASE_URL}${entry.mdPath}`;
  return entry.description
    ? `- [${entry.label}](${url}): ${entry.description}`
    : `- [${entry.label}](${url})`;
}

export function GET() {
  const grouped = groupBySection(docsManifest({ includeAdmin: adminDocs }));
  const sections = grouped
    .map(({ section, items }) => `## ${section}\n\n${items.map(line).join("\n")}`)
    .join("\n\n");

  const body = `# ${SITE_NAME}

> ${SUMMARY}

${CONTEXT}

${sections}

${MACHINE_ENDPOINTS}

${OPTIONAL}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
