import { errorFromResponse, ReleasesError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.releases.sh";

export interface ClientOptions {
  /**
   * A `relu_` user key, a `relk_` API token, or a publish token. Optional:
   * public reads work anonymously at a lower rate limit.
   */
  apiKey?: string;
  /** API origin. Defaults to `https://api.releases.sh`. */
  baseUrl?: string;
  /** A `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
}

/** Per-call options accepted by every method. */
export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Sent as `Idempotency-Key` on writes. Retrying with the same key replays
   * the first response instead of repeating the write.
   */
  idempotencyKey?: string;
}

export type QueryValue = string | number | boolean | null | undefined;

interface Call extends RequestOptions {
  /** Values for the `:name` segments of the operation's path. */
  params?: Record<string, string>;
  query?: object;
  body?: unknown;
}

/**
 * Sends one operation. `operation` is the API surface key, `"GET /orgs/:slug"`:
 * the same string `apps/api/src/api-surface.ts` lists, which a test checks so
 * the SDK only calls public routes.
 */
export class Transport {
  readonly #apiKey?: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#headers = options.headers ?? {};
  }

  async request<T>(operation: string, call: Call = {}): Promise<T> {
    const space = operation.indexOf(" ");
    const method = operation.slice(0, space);
    const path = buildPath(operation.slice(space + 1), call.params ?? {});
    const url = `${this.#baseUrl}/v1${path}${buildQuery(call.query)}`;

    const headers: Record<string, string> = { Accept: "application/json", ...this.#headers };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    if (call.body !== undefined) headers["Content-Type"] = "application/json";
    if (call.idempotencyKey) headers["Idempotency-Key"] = call.idempotencyKey;
    Object.assign(headers, call.headers);

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: call.signal,
      });
    } catch (cause) {
      throw new ReleasesError({
        status: 0,
        code: "network_error",
        type: "network",
        message: `${method} ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        method,
        path,
        cause,
      });
    }

    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      throw errorFromResponse(res.status, res.statusText, body, method, path);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

function buildPath(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "")
      throw new TypeError(`Missing path parameter "${name}"`);
    return encodeURIComponent(value);
  });
}

function buildQuery(query: object | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, QueryValue>)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
