/**
 * Raw-snapshot capture on the steady-state scrape path (#1283). The discovery
 * worker has no D1/R2, so it POSTs the scraped markdown to the API worker's
 * raw-snapshot endpoint — gated on the `raw-snapshot-capture-enabled` flag
 * (threaded as ScrapeEnv.captureRawSnapshots) and best-effort (a failure must
 * not abort extraction).
 */

import { describe, it, expect } from "bun:test";
import { captureRawSnapshot, type ScrapeEnv } from "@releases/adapters/scrape-fetch";

const source = {
  id: "src_x",
  orgId: "org_x",
  slug: "acme-blog",
  url: "https://acme.test/changelog",
  type: "scrape" as const,
} as never;

type Call = { url: string; init?: RequestInit };

function envWith(
  captureRawSnapshots: boolean,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): { env: ScrapeEnv; calls: Call[] } {
  const calls: Call[] = [];
  const env = {
    apiKey: "rel_key",
    captureRawSnapshots,
    apiFetcher: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, init });
        return fetchImpl ? fetchImpl(url, init) : new Response(JSON.stringify({ stored: true }));
      },
    },
  } as unknown as ScrapeEnv;
  return { env, calls };
}

describe("captureRawSnapshot (#1283)", () => {
  it("POSTs the markdown to the org-scoped raw-snapshot endpoint when enabled", async () => {
    const { env, calls } = envWith(true);
    await captureRawSnapshot(env, source, "# v1\nhello");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api/v1/orgs/org_x/sources/src_x/raw-snapshot");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer rel_key");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}");
    expect(body).toEqual({ body: "# v1\nhello", format: "markdown" });
  });

  it("does nothing when capture is disabled", async () => {
    const { env, calls } = envWith(false);
    await captureRawSnapshot(env, source, "# v1\nhello");
    expect(calls).toHaveLength(0);
  });

  it("skips an empty/whitespace body", async () => {
    const { env, calls } = envWith(true);
    await captureRawSnapshot(env, source, "   ");
    expect(calls).toHaveLength(0);
  });

  it("swallows a transport error (best-effort, never throws)", async () => {
    const { env } = envWith(true, async () => {
      throw new Error("network down");
    });
    // Resolves rather than rejecting — the caller continues to extraction.
    await expect(captureRawSnapshot(env, source, "# v1")).resolves.toBeUndefined();
  });

  it("swallows a non-2xx response", async () => {
    const { env, calls } = envWith(true, async () => new Response("nope", { status: 503 }));
    await expect(captureRawSnapshot(env, source, "# v1")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
