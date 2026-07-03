import { mock } from "bun:test";

// Process-global module mocks (bun mock.module is not restorable — these are
// deliberately benign, shared, and defined ONCE here; do not duplicate them
// in individual test files).
//
// IMPORTANT: bun resolves and loads the entire static module graph (including
// transitive imports) before executing any module-level code, so a static
// `import "./test-helpers"` followed by a static `import { fooAction } from
// "./foo"` does NOT guarantee this file's mock.module() calls run before
// foo.ts's own transitive `import "server-only"` is evaluated — they can lose
// the race and the real server-only throws. Test files MUST import this
// helper (for its side effects) and then load the action module via a
// dynamic `await import("./foo")` inside a `beforeAll`/test body, never a
// static `import ... from "./foo"` — dynamic import defers resolution until
// after this module has finished evaluating.
mock.module("server-only", () => ({}));

export const revalidatedPaths: string[] = [];
mock.module("next/cache", () => ({
  revalidatePath: (path: string, _type?: string) => {
    revalidatedPaths.push(path);
  },
}));

/** Route adminActionEnv() down its local-admin branch (no next/headers). */
export function enableLocalAdminEnv(): void {
  process.env.RELEASES_API_KEY = "test-admin-key";
  // Force-set (not `??=`) — the ambient .env / web/.env.local loaded by bun
  // already defines RELEASES_API_URL, which would otherwise leak a real host
  // into the recorded-request assertions.
  process.env.RELEASES_API_URL = "http://api.test.local";
}

/** Undo enableLocalAdminEnv() so isLocalAdminEnabled() sees no key configured. */
export function disableLocalAdminEnv(): void {
  delete process.env.RELEASES_API_KEY;
  delete process.env.RELEASED_API_KEY;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const originalFetch = globalThis.fetch;

/** Stub globalThis.fetch; records requests, returns the queued responses. */
export function stubFetch(responses: Response[]): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  const queue = [...responses];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    const body = init?.body != null ? String(init.body) : null;
    recorded.push({ url, method, headers, body });
    const next = queue.shift();
    if (!next) throw new Error("stubFetch: response queue exhausted");
    return next;
  }) as typeof fetch;
  return recorded;
}

/** Stub globalThis.fetch to reject (network error) on every call. */
export function stubFetchReject(error: Error): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    const body = init?.body != null ? String(init.body) : null;
    recorded.push({ url, method, headers, body });
    throw error;
  }) as typeof fetch;
  return recorded;
}

/** Restore the real globalThis.fetch after a stubFetch()/stubFetchReject() test. */
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}
