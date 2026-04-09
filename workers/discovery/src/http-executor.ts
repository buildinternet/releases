/**
 * HTTP-based CLI executor for worker context.
 *
 * Maps CLI command strings to REST API calls via the API worker's
 * service binding. Used by managed-discovery when running server-side
 * instead of the subprocess executor used in CLI context.
 */

/** Executes a CLI command string and returns the output. Matches CLIExecutor from managed-discovery.ts. */
type CLIExecutor = (command: string) => Promise<string>;

interface APIClientOptions {
  /** Fetcher — either a service binding or a base URL fetcher. */
  fetcher: Fetcher | { fetch: typeof fetch };
  /** Bearer token for authenticated requests. */
  apiKey: string;
  /** Base URL prefix (default: "https://api" for service bindings). */
  baseUrl?: string;
}

/**
 * Create a CLI executor that routes commands through the API worker.
 *
 * Parses the command string and maps it to the appropriate REST endpoint.
 * Falls back to returning an error for unmapped commands.
 */
export function createHTTPExecutor(opts: APIClientOptions): CLIExecutor {
  const baseUrl = opts.baseUrl ?? "https://api";

  async function api(method: string, path: string, body?: object): Promise<string> {
    const url = `${baseUrl}/v1${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    };

    try {
      const res = await opts.fetcher.fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      if (!res.ok) {
        return `Command failed (HTTP ${res.status}): ${text}`;
      }
      return text || "(no output)";
    } catch (err) {
      return `Command error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return async (command: string): Promise<string> => {
    const args = command.trim().split(/\s+/);
    const cmd = args[0];

    // ── list ──
    if (cmd === "list") {
      const params = new URLSearchParams();
      params.set("format", "json");
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--json") continue;
        if (args[i] === "--org" && args[i + 1]) { params.set("orgSlug", args[++i]); continue; }
        if (args[i] === "--query" && args[i + 1]) { params.set("query", args[++i]); continue; }
        if (args[i] === "--has-feed") { params.set("has_feed", "true"); continue; }
        if (args[i] === "--enrichable") { params.set("enrichable", "true"); continue; }
        if (args[i] === "--product" && args[i + 1]) { params.set("productSlug", args[++i]); continue; }
        if (args[i] === "--category" && args[i + 1]) { params.set("category", args[++i]); continue; }
        // Positional arg = source slug
        if (!args[i].startsWith("--")) { params.set("query", args[i]); }
      }
      return api("GET", `/sources?${params}`);
    }

    // ── discover ──
    if (cmd === "discover" && args[1]) {
      return api("GET", `/sources?query=${encodeURIComponent(args[1])}`);
    }

    // ── evaluate ──
    if (cmd === "evaluate" && args[1]) {
      // No dedicated endpoint — return the URL for the agent to assess
      return `Evaluate is not available in remote mode. URL: ${args[1]}`;
    }

    // ── add ──
    if (cmd === "add") {
      const body: Record<string, string> = {};
      let name = "";
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--url" && args[i + 1]) { body.url = args[++i]; continue; }
        if (args[i] === "--type" && args[i + 1]) { body.type = args[++i]; continue; }
        if (args[i] === "--org" && args[i + 1]) { body.orgSlug = args[++i]; continue; }
        if (args[i] === "--feed-url" && args[i + 1]) { body.feedUrl = args[++i]; continue; }
        if (args[i] === "--skip-eval") continue;
        if (!args[i].startsWith("--")) { name = args[i].replace(/^["']|["']$/g, ""); }
      }
      body.name = name;
      return api("POST", "/sources", body);
    }

    // ── fetch ──
    if (cmd === "fetch" && args[1] && !args[1].startsWith("--")) {
      const slug = args[1];
      const dryRun = args.includes("--dry-run");
      const params = new URLSearchParams();
      if (dryRun) params.set("dry_run", "true");
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--max" && args[i + 1]) { params.set("max", args[++i]); }
      }
      return api("POST", `/sources/${slug}/fetch?${params}`);
    }

    // ── fetch-log ──
    if (cmd === "fetch-log" && args[1]) {
      return api("GET", `/fetch-log?source=${encodeURIComponent(args[1])}`);
    }

    // ── remove ──
    if (cmd === "remove" && args[1]) {
      return api("DELETE", `/sources/${args[1]}`);
    }

    // ── edit ──
    if (cmd === "edit" && args[1]) {
      const slug = args[1];
      const body: Record<string, unknown> = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--primary") { body.isPrimary = true; continue; }
        if (args[i] === "--no-primary") { body.isPrimary = false; continue; }
        if (args[i] === "--priority" && args[i + 1]) { body.fetchPriority = args[++i]; continue; }
        if (args[i] === "--metadata" && args[i + 1]) {
          try { body.metadata = JSON.parse(args[++i]); } catch { /* skip */ }
        }
      }
      return api("PATCH", `/sources/${slug}`, body);
    }

    // ── enrich ──
    if (cmd === "enrich" && args[1]) {
      // Mark source for enrichment — the actual enrichment runs async
      return api("GET", `/sources/${args[1]}/releases?enrichable=true`);
    }

    // ── org ──
    if (cmd === "org") {
      const sub = args[1];
      if (sub === "add") {
        const body: Record<string, unknown> = {};
        let name = "";
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--domain" && args[i + 1]) { body.domain = args[++i]; continue; }
          if (args[i] === "--description" && args[i + 1]) { body.description = args[++i]; continue; }
          if (args[i] === "--category" && args[i + 1]) { body.category = args[++i]; continue; }
          if (args[i] === "--tags" && args[i + 1]) { body.tags = args[++i].split(","); continue; }
          if (!args[i].startsWith("--")) name = args[i].replace(/^["']|["']$/g, "");
        }
        body.name = name;
        return api("POST", "/orgs", body);
      }
      if (sub === "edit" && args[2]) {
        const slug = args[2];
        const body: Record<string, unknown> = {};
        for (let i = 3; i < args.length; i++) {
          if (args[i] === "--category" && args[i + 1]) { body.category = args[++i]; }
        }
        return api("PATCH", `/orgs/${slug}`, body);
      }
      if (sub === "show" && args[2]) {
        return api("GET", `/orgs/${args[2]}`);
      }
      if (sub === "tag" && args[2] === "add" && args[3]) {
        const slug = args[3];
        const tags = args.slice(4);
        return api("PUT", `/orgs/${slug}/tags`, { tags });
      }
    }

    // ── product ──
    if (cmd === "product") {
      const sub = args[1];
      if (sub === "add") {
        const body: Record<string, unknown> = {};
        let name = "";
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--org" && args[i + 1]) { body.orgSlug = args[++i]; continue; }
          if (args[i] === "--category" && args[i + 1]) { body.category = args[++i]; continue; }
          if (args[i] === "--tags" && args[i + 1]) { body.tags = args[++i].split(","); continue; }
          if (args[i] === "--url" && args[i + 1]) { body.url = args[++i]; continue; }
          if (args[i] === "--description" && args[i + 1]) { body.description = args[++i]; continue; }
          if (!args[i].startsWith("--")) name = args[i].replace(/^["']|["']$/g, "");
        }
        body.name = name;
        return api("POST", "/products", body);
      }
      if (sub === "edit" && args[2]) {
        const slug = args[2];
        const body: Record<string, unknown> = {};
        for (let i = 3; i < args.length; i++) {
          if (args[i] === "--category" && args[i + 1]) { body.category = args[++i]; }
        }
        return api("PATCH", `/products/${slug}`, body);
      }
      if (sub === "tag" && args[2] === "add" && args[3]) {
        const slug = args[3];
        const tags = args.slice(4);
        return api("PUT", `/products/${slug}/tags`, { tags });
      }
    }

    // ── ignore ──
    if (cmd === "ignore") {
      if (args[1] === "list") {
        const orgIdx = args.indexOf("--org");
        if (orgIdx !== -1 && args[orgIdx + 1]) {
          return api("GET", `/orgs/${args[orgIdx + 1]}/ignored-urls`);
        }
      }
      if (args[1] === "add") {
        const orgIdx = args.indexOf("--org");
        if (orgIdx !== -1 && args[orgIdx + 1]) {
          const org = args[orgIdx + 1];
          const url = args.find((a, i) => i > 1 && !a.startsWith("--") && i !== orgIdx + 1);
          if (url) return api("POST", `/orgs/${org}/ignored-urls`, { url });
        }
      }
    }

    // ── block ──
    if (cmd === "block") {
      if (args[1] === "list") return api("GET", "/blocked-urls");
      if (args[1] === "add" && args[2]) return api("POST", "/blocked-urls", { pattern: args[2] });
    }

    // ── categories ──
    if (cmd === "categories") {
      return api("GET", "/categories");
    }

    return `Unknown or unsupported command in remote mode: ${command}`;
  };
}
