export default function McpPage() {
  return (
    <>
      <h1>MCP Server</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Use Released as an AI agent tool server via the Model Context Protocol.
      </p>

      <h2>Starting the server</h2>
      <pre><code>{`released serve`}</code></pre>
      <p>
        This starts an MCP server on stdio, compatible with Claude Code, Cursor, Windsurf,
        and other MCP-compatible clients.
      </p>

      <h2>Configuration</h2>
      <p>
        Add Released to your MCP client config. For Claude Code, add
        to <code>.mcp.json</code>:
      </p>
      <pre><code>{`{
  "mcpServers": {
    "released": {
      "command": "released",
      "args": ["serve"]
    }
  }
}`}</code></pre>

      <h2>Available tools</h2>
      <p>
        The MCP server exposes 19 tools organized into read, analysis, and management categories.
      </p>

      <h3>Read tools</h3>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>search_releases</code></td><td>Full-text search across all indexed release notes. Supports filtering by product slug or organization.</td></tr>
          <tr><td><code>get_latest_releases</code></td><td>Get the most recent releases, optionally filtered by source or org.</td></tr>
          <tr><td><code>list_products</code></td><td>List all changelog sources (products) in the index.</td></tr>
          <tr><td><code>list_organizations</code></td><td>List all organizations with their source counts.</td></tr>
        </tbody>
      </table>

      <h3>Analysis tools</h3>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>summarize_changes</code></td><td>AI-generated summary of recent releases for a source.</td></tr>
          <tr><td><code>compare_products</code></td><td>Head-to-head comparison of releases between two sources.</td></tr>
        </tbody>
      </table>

      <h3>Source management tools</h3>
      <table>
        <thead>
          <tr><th>Tool</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>add_source</code></td><td>Add a new changelog source from a URL.</td></tr>
          <tr><td><code>remove_source</code></td><td>Remove a source from the index.</td></tr>
          <tr><td><code>fetch_source</code></td><td>Fetch new releases from a source.</td></tr>
          <tr><td><code>add_organization</code></td><td>Create a new organization.</td></tr>
          <tr><td><code>link_account</code></td><td>Link a social media account to an organization.</td></tr>
        </tbody>
      </table>

      <h3>Curation tools</h3>
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
        <li>&ldquo;Add the Astro changelog as a new source&rdquo;</li>
      </ul>
    </>
  );
}
