export default function DocsOverview() {
  return (
    <>
      <h1>Released</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Changelog index for AI agents and developers.
      </p>

      <p>
        Released tracks release notes, changelogs, and version updates across hundreds of developer tools,
        frameworks, and services. It provides a CLI, REST API, and MCP server for querying structured
        release data.
      </p>

      <h2>What you can do</h2>
      <ul>
        <li><strong>Browse and search</strong> — find releases across organizations and sources by keyword, category, or date</li>
        <li><strong>Track changes</strong> — fetch the latest releases from GitHub repos, RSS feeds, and changelog pages</li>
        <li><strong>AI summaries</strong> — generate natural-language summaries and comparisons of release activity</li>
        <li><strong>Integrate</strong> — use the REST API for programmatic access or the MCP server for AI agent workflows</li>
      </ul>

      <h2>Concepts</h2>
      <p>Released organizes data in a simple hierarchy:</p>
      <ul>
        <li><strong>Organizations</strong> — companies or teams (e.g., Vercel, Cloudflare)</li>
        <li><strong>Products</strong> — optional grouping within an org (e.g., Vercel → Next.js, Turborepo)</li>
        <li><strong>Sources</strong> — individual changelog feeds (e.g., a GitHub repo, an RSS feed, a changelog page)</li>
        <li><strong>Releases</strong> — individual entries with a title, version, date, and content</li>
      </ul>
      <p>
        Each source has a <code>slug</code> that uniquely identifies it and is used as the primary
        argument across CLI commands and API endpoints.
      </p>

      <h2>Interfaces</h2>
      <table>
        <thead>
          <tr>
            <th>Interface</th>
            <th>Best for</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>CLI</strong></td>
            <td>Interactive exploration, fetching, analysis</td>
          </tr>
          <tr>
            <td><strong>REST API</strong></td>
            <td>Programmatic access, web integrations</td>
          </tr>
          <tr>
            <td><strong>MCP Server</strong></td>
            <td>AI agent tool use (Claude, Cursor, etc.)</td>
          </tr>
          <tr>
            <td><strong>Web UI</strong></td>
            <td>Browsing the catalog at <a href="https://releases.sh">releases.sh</a></td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
