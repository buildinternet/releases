import { FirecrawlError } from "@releases/lib/errors";
import type { CreateMonitorRequest, Monitor, UpdateMonitorRequest } from "@mendable/firecrawl-js";

const BASE = "https://api.firecrawl.dev/v2";

export type FirecrawlProxy = "basic" | "enhanced" | "auto";

// Monitor request/response shapes reuse the official SDK's types rather than
// hand-rolled interfaces, so tsc validates them against the live v2 API. The
// imports are `import type` (erased at build), so the SDK and its axios runtime
// never enter the Worker bundle — the tiny fetch client below is what runs. #1248
export type FirecrawlMonitorSpec = CreateMonitorRequest;

export type FirecrawlMonitor = Monitor;

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
    async updateMonitor(id: string, spec: UpdateMonitorRequest): Promise<void> {
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
