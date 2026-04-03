export default function RestApiPage() {
  return (
    <>
      <h1>REST API</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Programmatic access to the Released index via HTTP.
      </p>

      <p>
        The API is a Cloudflare Worker backed by D1. All endpoints are prefixed
        with <code>/api</code> and return JSON.
      </p>

      <h2>Authentication</h2>
      <p>
        Read endpoints are public. Write endpoints require a Bearer token:
      </p>
      <pre><code>{`curl -H "Authorization: Bearer YOUR_KEY" https://api.releases.sh/api/...`}</code></pre>

      <hr />

      <h2>Stats</h2>
      <h3><code>GET /api/stats</code></h3>
      <p>Returns counts of organizations, sources, releases, and products.</p>

      <hr />

      <h2>Organizations</h2>

      <h3><code>GET /api/orgs</code></h3>
      <p>List all organizations with source counts and metadata.</p>

      <h3><code>GET /api/orgs/:slug</code></h3>
      <p>Get organization details including sources, products, and release metrics.</p>

      <h3><code>GET /api/orgs/:slug/releases</code></h3>
      <p>Paginated release feed across all sources in the org.</p>
      <table>
        <thead>
          <tr><th>Param</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>cursor</code></td><td>Pagination cursor from previous response</td></tr>
          <tr><td><code>limit</code></td><td>Results per page (1-100, default 20)</td></tr>
        </tbody>
      </table>

      <h3><code>GET /api/orgs/:slug/activity</code></h3>
      <p>Weekly release activity for the organization.</p>
      <table>
        <thead>
          <tr><th>Param</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>from</code></td><td>Start date (YYYY-MM-DD)</td></tr>
          <tr><td><code>to</code></td><td>End date (YYYY-MM-DD)</td></tr>
        </tbody>
      </table>

      <hr />

      <h2>Products</h2>

      <h3><code>GET /api/products</code></h3>
      <p>List products. Filter with <code>?orgId=...</code>.</p>

      <h3><code>GET /api/products/:slug</code></h3>
      <p>Get product details by slug or ID.</p>

      <hr />

      <h2>Sources</h2>

      <h3><code>GET /api/sources</code></h3>
      <p>List sources with filters.</p>
      <table>
        <thead>
          <tr><th>Param</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>independent</code></td><td>Only sources not tied to an org</td></tr>
          <tr><td><code>orgSlug</code></td><td>Filter by organization slug</td></tr>
          <tr><td><code>productSlug</code></td><td>Filter by product slug</td></tr>
          <tr><td><code>hasFeed</code></td><td>Only sources with a feed URL</td></tr>
          <tr><td><code>enrichable</code></td><td>Sources eligible for enrichment</td></tr>
          <tr><td><code>query</code></td><td>Substring search on name, slug, or URL</td></tr>
          <tr><td><code>category</code></td><td>Filter by category</td></tr>
        </tbody>
      </table>

      <h3><code>GET /api/sources/:slug</code></h3>
      <p>Source details with paginated releases.</p>
      <table>
        <thead>
          <tr><th>Param</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>page</code></td><td>Page number</td></tr>
          <tr><td><code>pageSize</code></td><td>Results per page</td></tr>
        </tbody>
      </table>

      <h3><code>GET /api/sources/:slug/activity</code></h3>
      <p>Weekly release activity for a source. Accepts <code>from</code> and <code>to</code> date params.</p>

      <h3><code>GET /api/sources/:slug/recent-releases</code></h3>
      <p>Releases after a cutoff date. Requires <code>?cutoff=ISO-date</code>.</p>

      <hr />

      <h2>Releases</h2>

      <h3><code>GET /api/releases/:id</code></h3>
      <p>Get full release details by ID, including content and media assets.</p>

      <hr />

      <h2>Search</h2>

      <h3><code>GET /api/search</code></h3>
      <p>Full-text search across orgs, products, sources, and releases.</p>
      <table>
        <thead>
          <tr><th>Param</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>q</code></td><td>Search query (required)</td></tr>
          <tr><td><code>limit</code></td><td>Max results (default 20)</td></tr>
          <tr><td><code>offset</code></td><td>Pagination offset</td></tr>
        </tbody>
      </table>

      <hr />

      <h2>Summaries</h2>

      <h3><code>GET /api/summaries</code></h3>
      <p>Get cached AI summaries for a source.</p>
      <table>
        <thead>
          <tr><th>Param</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>sourceSlug</code></td><td>Source slug (required, or use sourceId)</td></tr>
          <tr><td><code>type</code></td><td><code>rolling</code> or <code>monthly</code></td></tr>
          <tr><td><code>year</code></td><td>Filter by year (for monthly summaries)</td></tr>
          <tr><td><code>month</code></td><td>Filter by month</td></tr>
        </tbody>
      </table>

      <hr />

      <h2>Format exports</h2>
      <p>The web app exposes format endpoints for machine-readable export of release data:</p>
      <pre><code>{`GET /api/format/:orgSlug.json        # Org releases as JSON
GET /api/format/:orgSlug.md          # Org releases as Markdown
GET /api/format/:orgSlug/:source.json
GET /api/format/:orgSlug/:source.md
GET /api/format/source/:slug.json
GET /api/format/source/:slug.md`}</code></pre>
    </>
  );
}
