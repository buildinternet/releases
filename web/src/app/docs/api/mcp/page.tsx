export default function McpPage() {
  return (
    <>
      <h1>MCP Server</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Use Released as an AI agent tool server via the Model Context Protocol.
      </p>

      <h2>Remote server (recommended)</h2>
      <p>
        Connect to the hosted MCP server at <code>mcp.releases.sh</code>.
        No installation or API keys required &mdash; all tools are read-only and public.
      </p>
      <pre><code>{`{
  "mcpServers": {
    "releases": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.releases.sh/mcp"]
    }
  }
}`}</code></pre>
      <p>
        This works with Claude Code, Claude Desktop, Cursor, Windsurf, and any
        MCP-compatible client that supports remote servers.
      </p>

      <h2>Local server</h2>
      <p>
        Run a local MCP server over stdio with the full tool set, including admin tools
        for adding sources, fetching releases, and managing organizations:
      </p>
      <pre><code>{`released serve`}</code></pre>
      <pre><code>{`{
  "mcpServers": {
    "releases": {
      "command": "released",
      "args": ["serve"]
    }
  }
}`}</code></pre>

      <h2>Available tools</h2>

      <h3>Read tools</h3>
      <p>Available on both the remote and local servers.</p>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>search_releases</code></td><td>Full-text search across all indexed release notes. Supports filtering by product slug or organization.</td></tr>
          <tr><td><code>get_latest_releases</code></td><td>Get the most recent releases, optionally filtered by product or organization.</td></tr>
          <tr><td><code>list_products</code></td><td>List all changelog sources (products) in the index.</td></tr>
          <tr><td><code>list_organizations</code></td><td>List all organizations, searchable by name, slug, domain, or account handle.</td></tr>
          <tr><td><code>get_organization</code></td><td>Detailed view of a single organization including accounts, tags, sources, products, and domain aliases.</td></tr>
        </tbody>
      </table>

      <h3>Analysis tools</h3>
      <p>Available on both the remote and local servers. Powered by Anthropic Claude.</p>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>summarize_changes</code></td><td>AI-generated summary of recent releases for a product. Supports custom lookback window and additional instructions.</td></tr>
          <tr><td><code>compare_products</code></td><td>Head-to-head AI comparison of releases between two products.</td></tr>
        </tbody>
      </table>

      <h3>Source management tools</h3>
      <p>Only available on the local server.</p>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>add_source</code></td><td>Add a new changelog source from a URL.</td></tr>
          <tr><td><code>remove_source</code></td><td>Remove a source from the index.</td></tr>
          <tr><td><code>fetch_source</code></td><td>Fetch new releases from a source.</td></tr>
          <tr><td><code>add_organization</code></td><td>Create a new organization.</td></tr>
          <tr><td><code>link_account</code></td><td>Link a platform account to an organization.</td></tr>
        </tbody>
      </table>

      <h3>Curation tools</h3>
      <p>Only available on the local server.</p>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>suppress_release</code></td><td>Hide a release from queries and search.</td></tr>
          <tr><td><code>unsuppress_release</code></td><td>Restore a suppressed release.</td></tr>
          <tr><td><code>ignore_url</code></td><td>Add a URL to an org&apos;s ignore list.</td></tr>
          <tr><td><code>unignore_url</code></td><td>Remove a URL from the ignore list.</td></tr>
          <tr><td><code>list_ignored_urls</code></td><td>List ignored URLs for an organization.</td></tr>
          <tr><td><code>block_url</code></td><td>Globally block a URL pattern.</td></tr>
          <tr><td><code>unblock_url</code></td><td>Remove a global URL block.</td></tr>
          <tr><td><code>list_blocked_urls</code></td><td>List all globally blocked URLs.</td></tr>
        </tbody>
      </table>

      <h2>Example usage with Claude</h2>
      <p>
        Once configured, you can ask Claude to interact with the release index directly:
      </p>
      <ul>
        <li>&ldquo;What did Vercel ship last week?&rdquo;</li>
        <li>&ldquo;Search for breaking changes in the Prisma changelog&rdquo;</li>
        <li>&ldquo;Compare Next.js and Remix releases from the last 30 days&rdquo;</li>
        <li>&ldquo;Summarize Cloudflare&apos;s recent releases, focusing on Workers&rdquo;</li>
      </ul>
    </>
  );
}
