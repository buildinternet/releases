/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared fixtures for workflow test files (phases 1–3). Each phase's class
 * has its own Env shape; the harness here is generic over those, with the
 * understanding that the per-test mkEnv stays local since env shape diverges.
 */

export type StepRecord = { name: string; attempts: number; ok: boolean; error?: string };

/**
 * In-process WorkflowStep stand-in. Honors the `retries.limit` config so
 * tests can drive recoverable + exhaust-retry paths. Records each invocation
 * (name + attempt count + ok flag) for assertions.
 */
export function mkFakeStep() {
  const records: StepRecord[] = [];
  const step = {
    async do<T>(name: string, a: any, b?: any): Promise<T> {
      const config = typeof a === "object" && a !== null && !("call" in a) ? a : undefined;
      const cb = (b ?? a) as () => Promise<T>;
      const retryLimit =
        (config as { retries?: { limit: number } } | undefined)?.retries?.limit ?? 0;
      let attempts = 0;
      let lastError: unknown;
      for (let i = 0; i <= retryLimit; i++) {
        attempts++;
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await cb();
          records.push({ name, attempts, ok: true });
          return result;
        } catch (err) {
          lastError = err;
          // Constructor-name check (not instanceof): cloudflare:workflows isn't
          // available under bun:test, so the production `NonRetryableError`
          // class identity diverges. The string match is the only stable
          // signal that a workflow step opted out of retry.
          const isNonRetryable =
            err instanceof Error && err.constructor.name === "NonRetryableError";
          if (isNonRetryable) break;
        }
      }
      records.push({
        name,
        attempts,
        ok: false,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      throw lastError;
    },
    async sleep() {},
    async sleepUntil() {},
    async waitForEvent() {
      throw new Error("waitForEvent not expected");
    },
  };
  return { step, records };
}

/** Body text long enough to clear the empty-tier embed/search gate (MIN_CONTENT_CHARS). */
const ATOM_ENTRY_BODY = "Release notes for this version with enough text to embed and search.";

export function atomBody(entries: Array<{ id: string; title: string }>) {
  const items = entries
    .map(
      (e) =>
        `<entry><id>${e.id}</id><title>${e.title}</title><link href="${e.id}"/><updated>2026-01-01T00:00:00Z</updated><content>${ATOM_ENTRY_BODY}</content></entry>`,
    )
    .join("");
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>acme</id><title>Acme</title>${items}</feed>`;
}

/**
 * Build a fake `globalThis.fetch` that serves:
 * - HEAD `https://a.test/feed` → 200 with an ETag (poll phase).
 * - GET `https://a.test/feed` → 200 with an Atom feed of `feedEntries`.
 * - POST `api.voyageai.com` → deterministic vectors unless `voyageBehavior` throws.
 *
 * Anything else returns 404 so typos surface fast.
 */
export interface AnthropicCall {
  /** The user-message body string (the "release block" the prompt builder sends). */
  body: string;
}

export function mkFetch(opts: {
  feedEntries?: Array<{ id: string; title: string }>;
  voyageBehavior?: () => void;
  /** Throws here surface as upstream Anthropic errors inside the generate step. */
  anthropicBehavior?: (call: AnthropicCall) => {
    title: string;
    titleShort: string;
    summary: string;
  };
}) {
  const voyageCalls: Array<{ input: string[] }> = [];
  const anthropicCalls: AnthropicCall[] = [];
  return {
    voyageCalls,
    anthropicCalls,
    impl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";

      if (url.includes("a.test/feed")) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { ETag: `"v1-${opts.feedEntries?.length ?? 0}"` },
          });
        }
        return new Response(atomBody(opts.feedEntries ?? []), {
          status: 200,
          headers: { "Content-Type": "application/atom+xml" },
        });
      }

      if (url.includes("voyageai.com")) {
        if (opts.voyageBehavior) opts.voyageBehavior();
        const body = JSON.parse(String(init?.body ?? "{}"));
        voyageCalls.push({ input: body.input });
        const data = body.input.map((_: string, i: number) => ({
          embedding: [i, i, i],
          index: i,
        }));
        return new Response(JSON.stringify({ data, usage: { total_tokens: 1 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("api.anthropic.com")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const userMsg = body.messages?.[0]?.content ?? "";
        const call: AnthropicCall = { body: String(userMsg) };
        anthropicCalls.push(call);
        if (!opts.anthropicBehavior) {
          return new Response("no anthropicBehavior configured", { status: 500 });
        }
        try {
          const out = opts.anthropicBehavior(call);
          const text = `<title>${out.title}</title><title_short>${out.titleShort}</title_short><summary>${out.summary}</summary>`;
          return new Response(
            JSON.stringify({
              id: "msg_test",
              type: "message",
              role: "assistant",
              model: "claude-haiku-4-5",
              stop_reason: "end_turn",
              content: [{ type: "text", text }],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
        }
      }

      return new Response(`unexpected ${method} ${url}`, { status: 404 });
    }) as unknown as typeof fetch,
  };
}

/**
 * Fake VectorizeIndex. `upsertBehavior` lets tests force the binding to throw
 * on a given invocation — that's how we drive "embed step retries on Vectorize
 * failure" cases without touching real infra.
 */
export function mkVectorize(opts: { upsertBehavior?: () => void } = {}) {
  const upserted: any[][] = [];
  const index = {
    async upsert(v: any[]) {
      if (opts.upsertBehavior) opts.upsertBehavior();
      upserted.push(v);
      return { mutationId: `m${upserted.length}` };
    },
    async deleteByIds(_ids: string[]) {
      return { mutationId: "del" };
    },
  } as any;
  return { index, upserted };
}
