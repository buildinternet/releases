import { FirecrawlError } from "@releases/lib/errors";
import type { CreateMonitorRequest } from "@mendable/firecrawl-js";

const BASE = "https://api.firecrawl.dev/v2";

export type FirecrawlProxy = "basic" | "enhanced" | "auto";

// The monitor request shape is the official SDK's type, not a hand-rolled
// interface. We keep the tiny fetch-based client below — the SDK's runtime
// transport is axios, unwanted weight/compat risk in a Worker bundle — but
// borrow its types so the body we POST is compile-time-validated against the
// live v2 API. `import type` is erased at build, so @mendable/firecrawl-js (and
// its axios dependency) never enter the Worker bundle. A prior hand-rolled
// shape silently drifted from the API (bare-string schedule, `url` vs `urls`,
// top-level proxy) and only surfaced when a live create would 400; these types
// prevent that class of bug. See issue #1248.
export type FirecrawlMonitorSpec = CreateMonitorRequest;

export interface FirecrawlMonitor {
  id: string;
  [k: string]: unknown;
}

export interface FirecrawlClientOpts {
  apiKey: string;
  fetch?: typeof fetch;
}

async function call(
  f: typeof fetch,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await f(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new FirecrawlError(res.status, method, path, text);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new FirecrawlError(
      res.status,
      method,
      path,
      text,
      `Firecrawl ${method} ${path} returned non-JSON 2xx body: ${text.slice(0, 200)}`,
    );
  }
}

export function createFirecrawlClient(opts: FirecrawlClientOpts) {
  const f = opts.fetch ?? fetch;
  const key = opts.apiKey;
  return {
    async createMonitor(spec: FirecrawlMonitorSpec): Promise<string> {
      const json = (await call(f, key, "POST", "/monitor", spec)) as { monitor?: { id?: string } };
      const id = json?.monitor?.id;
      if (!id) throw new Error("Firecrawl createMonitor returned no monitor id");
      return id;
    },
    async getMonitor(id: string): Promise<FirecrawlMonitor> {
      const json = (await call(f, key, "GET", `/monitor/${id}`)) as { monitor?: FirecrawlMonitor };
      if (!json?.monitor) throw new Error(`Firecrawl getMonitor ${id} returned no monitor`);
      return json.monitor;
    },
    async updateMonitor(id: string, spec: FirecrawlMonitorSpec): Promise<void> {
      await call(f, key, "PUT", `/monitor/${id}`, spec);
    },
    async deleteMonitor(id: string): Promise<void> {
      await call(f, key, "DELETE", `/monitor/${id}`);
    },
    async runMonitor(id: string): Promise<void> {
      await call(f, key, "POST", `/monitor/${id}/run`);
    },
    async scrapeOnce(url: string, p?: { proxy?: FirecrawlProxy }): Promise<string> {
      const json = (await call(f, key, "POST", "/scrape", {
        url,
        formats: ["markdown"],
        proxy: p?.proxy ?? "auto",
      })) as { data?: { markdown?: string } };
      return json?.data?.markdown ?? "";
    },
  };
}

export type FirecrawlClient = ReturnType<typeof createFirecrawlClient>;
