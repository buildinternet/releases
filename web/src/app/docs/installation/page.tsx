export default function InstallationPage() {
  return (
    <>
      <h1>Installation</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Get the Released CLI running locally or via the compiled binary.
      </p>

      <h2>From source (development)</h2>
      <p>Requires <a href="https://bun.sh">Bun</a> v1.1+.</p>
      <pre><code>{`git clone https://github.com/zachdunn/released.git
cd released
bun install
bun src/index.ts --help`}</code></pre>

      <h2>Compiled binary</h2>
      <p>Build a self-contained binary for your platform:</p>
      <pre><code>{`bun run build          # macOS
bun run build:linux    # Linux (for containers)`}</code></pre>
      <p>
        The output lands in <code>dist/</code>. The compiled binary operates in remote mode only —
        it requires <code>RELEASED_API_URL</code> to be set.
      </p>

      <h2>Local vs. Remote mode</h2>
      <p>The CLI operates in two modes depending on environment variables:</p>

      <h3>Local mode (default)</h3>
      <p>No configuration needed. Uses a local SQLite database at <code>~/.released/released.db</code>.</p>
      <pre><code>{`bun src/index.ts list`}</code></pre>

      <h3>Remote mode</h3>
      <p>
        Set <code>RELEASED_API_URL</code> and <code>RELEASED_API_KEY</code> to route all operations
        through the Cloudflare Worker API backed by D1.
      </p>
      <pre><code>{`export RELEASED_API_URL=https://api.releases.sh
export RELEASED_API_KEY=your-key
released list`}</code></pre>

      <h2>MCP server</h2>
      <p>To use Released as an MCP tool server (for Claude, Cursor, etc.):</p>
      <pre><code>{`released serve`}</code></pre>
      <p>
        This starts the MCP server on stdio. See the <a href="/docs/api/mcp">MCP Server</a> docs
        for configuration details.
      </p>
    </>
  );
}
