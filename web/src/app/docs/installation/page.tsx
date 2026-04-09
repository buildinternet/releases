import { InstallTabs } from "@/components/install-tabs";

export default function InstallationPage() {
  return (
    <>
      <h1>Installation</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Get the Released CLI up and running.
      </p>

      <div className="not-prose my-8">
        <InstallTabs />
      </div>

      <h2>npm</h2>
      <p>Install globally via npm — prebuilt binaries for macOS and Linux are included:</p>
      <pre><code>{`npm install -g @buildinternet/releases`}</code></pre>
      <p>Or run without installing:</p>
      <pre><code>{`npx @buildinternet/releases search "react"`}</code></pre>

      <h2>Shell script</h2>
      <p>Download and install the latest binary directly:</p>
      <pre><code>{`curl -fsSL https://releases.sh/install | bash`}</code></pre>
      <p>
        The script detects your platform, downloads the correct binary from npm, and
        installs it to <code>/usr/local/bin</code>. Set <code>RELEASED_INSTALL_DIR</code> to
        change the install location.
      </p>

      <h2>From source (development)</h2>
      <p>Requires <a href="https://bun.sh">Bun</a> v1.1+.</p>
      <pre><code>{`git clone https://github.com/buildinternet/released.git
cd released
bun install
bun src/index.ts --help`}</code></pre>

      <h2>Verify</h2>
      <p>After installing, verify the CLI is working:</p>
      <pre><code>{`releases --help`}</code></pre>

      <h2>MCP server</h2>
      <p>To use Released as an MCP tool server (for Claude, Cursor, etc.):</p>
      <pre><code>{`releases serve`}</code></pre>
      <p>
        This starts the MCP server on stdio. See the <a href="/docs/api/mcp">MCP Server</a> docs
        for configuration details.
      </p>
    </>
  );
}
