/**
 * Minimal HTML landing page served at `/` when the client accepts HTML.
 * Programmatic clients (Accept: application/json, curl without -H, MCP
 * clients) continue to receive the JSON descriptor — see index.ts.
 *
 * Design mirrors releases.sh: stone palette, JetBrains Mono, same copy
 * tone as the homepage hero.
 */

const DOCS_URL = "https://releases.sh/docs/api/mcp";
const SITE_URL = "https://releases.sh";

// Same markup as web/src/app/icon.svg — inlined so the worker stays a single
// module and doesn't need asset bindings.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c1917"/><rect x="14" y="18" width="28" height="6" rx="1.5" fill="#f5f5f4"/><rect x="14" y="29" width="22" height="6" rx="1.5" fill="#f5f5f4" opacity="0.7"/><rect x="14" y="40" width="36" height="6" rx="1.5" fill="oklch(0.60 0.18 252)"/></svg>`;
const ICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(ICON_SVG)}`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderLandingPage(mcpUrl: string): string {
  const safeUrl = escapeHtml(mcpUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Releases MCP</title>
    <meta name="description" content="A unified registry of product release information, available over MCP." />
    <link rel="icon" type="image/svg+xml" href="${ICON_DATA_URL}" />
    <style>
      :root {
        color-scheme: light;
        --bg: #fafaf9;        /* stone-50 */
        --fg: #1c1917;        /* stone-900 */
        --muted: #78716c;     /* stone-500 */
        --muted-2: #a8a29e;   /* stone-400 */
        --border: #e7e5e4;    /* stone-200 */
        --code-bg: #f5f5f4;   /* stone-100 */
        --hover: #e7e5e4;     /* stone-200 */
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #0c0a09;      /* stone-950 */
          --fg: #f5f5f4;      /* stone-100 */
          --muted: #a8a29e;   /* stone-400 */
          --muted-2: #78716c; /* stone-500 */
          --border: #292524;  /* stone-800 */
          --code-bg: #1c1917; /* stone-900 */
          --hover: #292524;   /* stone-800 */
        }
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        background: var(--bg);
        color: var(--fg);
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-feature-settings: "ss01", "cv01";
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      main {
        max-width: 560px;
        width: 100%;
        margin: 0 auto;
        padding: 72px 24px 48px;
        flex: 1;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 40px;
      }
      .brand svg { width: 22px; height: 22px; border-radius: 5px; }
      .brand span {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--fg);
      }
      .brand a { color: inherit; text-decoration: none; }
      h1 {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.02em;
        margin: 0 0 8px;
        color: var(--fg);
      }
      p.lede {
        color: var(--muted);
        margin: 0 0 40px;
        font-size: 15px;
      }
      h2 {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted-2);
        margin: 0 0 12px;
      }
      .url-row {
        display: flex;
        align-items: stretch;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--code-bg);
        overflow: hidden;
        margin-bottom: 12px;
      }
      a.docs-link {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--code-bg);
        color: var(--fg);
        font-size: 13px;
        text-decoration: none;
        transition: background-color 0.1s ease;
      }
      a.docs-link:hover { background: var(--hover); }
      a.docs-link:focus-visible {
        outline: 2px solid var(--fg);
        outline-offset: 2px;
      }
      a.docs-link .arrow {
        color: var(--muted-2);
        font-size: 14px;
        line-height: 1;
      }
      a.docs-link:hover .arrow { color: var(--fg); }
      .url-row code {
        flex: 1;
        padding: 12px 14px;
        font-family: inherit;
        font-size: 13px;
        color: var(--fg);
        overflow-x: auto;
        white-space: nowrap;
      }
      button.copy {
        border: none;
        border-left: 1px solid var(--border);
        background: transparent;
        color: var(--fg);
        font: inherit;
        font-size: 12px;
        padding: 0 16px;
        cursor: pointer;
        min-width: 76px;
        transition: background-color 0.1s ease;
      }
      button.copy:hover { background: var(--hover); }
      button.copy:focus-visible {
        outline: 2px solid var(--fg);
        outline-offset: -2px;
      }
      footer {
        max-width: 560px;
        margin: 0 auto;
        padding: 24px;
        color: var(--muted-2);
        font-size: 12px;
        border-top: 1px solid var(--border);
      }
      footer a {
        color: var(--muted);
        text-decoration: none;
        border-bottom: 1px solid var(--border);
      }
      footer a:hover { color: var(--fg); border-bottom-color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <a href="${SITE_URL}" aria-label="releases.sh home">
          ${ICON_SVG}
        </a>
        <span><a href="${SITE_URL}">releases.sh</a></span>
      </div>

      <h1>Releases MCP</h1>
      <p class="lede">A unified registry of product release information, available over MCP.</p>

      <h2>Endpoint</h2>
      <div class="url-row">
        <code id="mcp-url">${safeUrl}</code>
        <button type="button" class="copy" data-copy-target="mcp-url" aria-label="Copy endpoint URL">Copy</button>
      </div>
      <a class="docs-link" href="${DOCS_URL}">
        <span>Read the documentation</span>
        <span class="arrow" aria-hidden="true">→</span>
      </a>
    </main>

    <footer>
      <a href="${SITE_URL}">Browse the registry at releases.sh</a>
    </footer>

    <script>
      document.querySelectorAll("button.copy").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const targetId = btn.getAttribute("data-copy-target");
          const el = targetId ? document.getElementById(targetId) : null;
          const text = el?.textContent ?? "";
          try {
            await navigator.clipboard.writeText(text);
            const original = btn.textContent;
            btn.textContent = "Copied";
            setTimeout(() => { btn.textContent = original; }, 1500);
          } catch {
            const range = document.createRange();
            if (el) {
              range.selectNode(el);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }
          }
        });
      });
    </script>
  </body>
</html>
`;
}

export function isHtmlRequest(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  return accept.includes("text/html");
}
