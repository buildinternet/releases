export default function BrowsingPage() {
  return (
    <>
      <h1>Browsing &amp; Search</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Find organizations, sources, and releases in the index.
      </p>

      <h2>List sources</h2>
      <p>
        The <code>list</code> command shows all configured changelog sources, or details for a single one.
      </p>
      <pre><code>{`released list                        # All sources
released list claude-code            # Details for one source
released list --org vercel           # Sources for an org
released list --has-feed             # Only sources with a feed URL
released list --query "tailwind"     # Search by name, slug, or URL
released list --category ai          # Filter by category
released list --json                 # Machine-readable output`}</code></pre>

      <h3>Filters</h3>
      <table>
        <thead>
          <tr><th>Flag</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--org &lt;slug&gt;</code></td><td>Filter by organization</td></tr>
          <tr><td><code>--product &lt;slug&gt;</code></td><td>Filter by product</td></tr>
          <tr><td><code>--has-feed</code></td><td>Only sources with a discovered feed URL</td></tr>
          <tr><td><code>--enrichable</code></td><td>Sources eligible for content enrichment</td></tr>
          <tr><td><code>--query &lt;text&gt;</code></td><td>Substring match on name, slug, or URL</td></tr>
          <tr><td><code>--category &lt;cat&gt;</code></td><td>Filter by org or product category</td></tr>
          <tr><td><code>--include-disabled</code></td><td>Include disabled sources</td></tr>
        </tbody>
      </table>

      <h2>Latest releases</h2>
      <p>
        The <code>latest</code> command shows the most recent releases, optionally filtered by source or org.
      </p>
      <pre><code>{`released latest                          # Across all sources
released latest claude-code              # From one source
released latest --org vercel --count 20  # Latest 20 from an org
released latest --json                   # JSON output`}</code></pre>

      <h2>Search</h2>
      <p>
        Full-text search across organizations, products, sources, and releases.
      </p>
      <pre><code>{`released search "breaking change"
released search "authentication" --type releases --limit 5
released search "vercel" --json`}</code></pre>

      <h3>Options</h3>
      <table>
        <thead>
          <tr><th>Flag</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--type &lt;type&gt;</code></td><td>Limit results to <code>orgs</code>, <code>products</code>, <code>sources</code>, or <code>releases</code></td></tr>
          <tr><td><code>--limit &lt;n&gt;</code></td><td>Max results per type (default 10)</td></tr>
          <tr><td><code>--json</code></td><td>Machine-readable output</td></tr>
        </tbody>
      </table>

      <h2>Categories</h2>
      <p>
        Organizations and products are tagged with a category. List valid values with:
      </p>
      <pre><code>{`released categories`}</code></pre>

      <h2>Stats</h2>
      <p>
        Get a quick count of organizations, sources, releases, and products in the database:
      </p>
      <pre><code>{`released stats`}</code></pre>

      <h2>Fetch log</h2>
      <p>Check the recent fetch history for a source to see when it was last updated and whether any errors occurred:</p>
      <pre><code>{`released fetch-log claude-code`}</code></pre>
    </>
  );
}
