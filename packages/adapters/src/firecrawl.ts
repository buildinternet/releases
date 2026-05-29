import { FirecrawlError } from "@releases/lib/errors";

const BASE = "https://api.firecrawl.dev/v2";

export type FirecrawlProxy = "basic" | "enhanced" | "auto";

export interface FirecrawlMonitorSpec {
  name: string;
  schedule: string; // cron or natural-language; 15-min minimum
  targets: Array<{ type: "scrape" | "crawl"; url: string }>;
  proxy: FirecrawlProxy;
  goal?: string;
  judgeEnabled: boolean;
  webhook: {
    url: string;
    headers: Record<string, string>;
    metadata: Record<string, string>;
    events: Array<"page" | "check.completed">;
  };
}

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
