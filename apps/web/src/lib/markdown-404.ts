/**
 * Shared markdown 404 body served to agents/CLIs that asked for markdown
 * (`.md` suffix or `Accept: text/markdown`) for a page that doesn't exist.
 * Points to the machine-readable surfaces instead of a bare error, since a
 * markdown-requesting caller is very likely an agent trying to navigate the
 * site programmatically. Used by `formatErrorResponse` (the `/api/format/**`
 * choke point) and the docs route's own not-found path.
 */
export const MARKDOWN_404_BODY = `# 404 — Not found

Nothing lives at this URL.

Where to look next:

- Site map and quick facts: https://releases.sh/llms.txt
- Docs index: https://releases.sh/docs.md
- REST API: https://api.releases.sh/v1 (OpenAPI spec: https://api.releases.sh/v1/openapi.json)
- Search the registry: https://api.releases.sh/v1/search?q=<your-query>

Any page on this site is available as Markdown by appending \`.md\` to its URL.
`;
