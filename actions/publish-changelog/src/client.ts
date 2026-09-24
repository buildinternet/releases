/**
 * Thin Releases API client for the publish Action.
 * Auth failures (missing token, 401, 403) fail closed — no retry, no fallback write path.
 */

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type BatchRelease = {
  title: string;
  content: string;
  url: string;
  publishedAt?: string | null;
  version?: string | null;
  type?: "feature" | "rollup";
  prerelease?: boolean;
};

export type BatchResponse = {
  inserted: number;
  total: number;
  insertedIds?: string[];
};

export type ListedRelease = {
  id: string;
  url: string | null;
  publishedAt: string | null;
};

export function batchPath(source: string, org?: string): string {
  const src = source.trim();
  const orgSlug = org?.trim();
  if (orgSlug)
    return `/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(src)}/releases/batch`;
  return `/v1/sources/${encodeURIComponent(src)}/releases/batch`;
}

export function sourceReleasesPath(source: string, org?: string): string {
  const src = source.trim();
  const orgSlug = org?.trim();
  if (orgSlug)
    return `/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(src)}/releases`;
  return `/v1/sources/${encodeURIComponent(src)}/releases`;
}

export function requireApiToken(token: string | undefined): string {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) {
    throw new AuthError(
      "Releases API token is missing. Set the api-token input (write-scoped relk_…).",
      401,
    );
  }
  return trimmed;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function errorMessage(status: number, text: string): string {
  const parsed = parseJson(text) as { error?: { message?: string } };
  const fromApi = parsed.error?.message;
  if (typeof fromApi === "string" && fromApi.length > 0) return fromApi;
  return text.slice(0, 400) || `HTTP ${status}`;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; token: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${init.token}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(
      `Releases API rejected the token (${res.status}). Use a write-scoped relk_… token, or a publish token bound to this source. ${errorMessage(res.status, text)}`,
      res.status,
    );
  }
  if (!res.ok) {
    throw new ApiError(`POST/GET failed: ${errorMessage(res.status, text)}`, res.status);
  }
  return { status: res.status, body: parseJson(text) };
}

export async function postReleaseBatch(
  fetchImpl: FetchLike,
  opts: {
    apiUrl: string;
    token: string;
    source: string;
    org?: string;
    releases: BatchRelease[];
  },
): Promise<BatchResponse> {
  const { body } = await requestJson(
    fetchImpl,
    `${opts.apiUrl}${batchPath(opts.source, opts.org)}`,
    {
      method: "POST",
      token: opts.token,
      body: { mode: "upsert-content", releases: opts.releases },
    },
  );
  const parsed = body as BatchResponse;
  return {
    inserted: Number(parsed.inserted ?? 0),
    total: Number(parsed.total ?? 0),
    insertedIds: Array.isArray(parsed.insertedIds) ? parsed.insertedIds : [],
  };
}

export async function listSourceReleases(
  fetchImpl: FetchLike,
  opts: {
    apiUrl: string;
    token: string;
    source: string;
    org?: string;
  },
): Promise<ListedRelease[]> {
  const out: ListedRelease[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${opts.apiUrl}${sourceReleasesPath(opts.source, opts.org)}`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const { body } = await requestJson(fetchImpl, url.toString(), {
      method: "GET",
      token: opts.token,
    });
    const page = body as {
      releases?: { id: string; url?: string | null; publishedAt?: string | null }[];
      pagination?: { nextCursor?: string | null };
    };
    for (const r of page.releases ?? []) {
      out.push({ id: r.id, url: r.url ?? null, publishedAt: r.publishedAt ?? null });
    }
    cursor = page.pagination?.nextCursor ?? null;
  } while (cursor);
  return out;
}

export type GenerateContentResult =
  | { scanned: number; generated: number }
  | { skipped: "unauthorized" };

/**
 * Admin workflow. Write-only tokens 401/403 here; those are skipped so a
 * customer `relk_` with `write` still succeeds after batch (which already
 * queues the fill-only generate-content side effect).
 */
export async function postGenerateContent(
  fetchImpl: FetchLike,
  opts: {
    apiUrl: string;
    token: string;
    sourceId: string;
    releaseIds: string[];
    regenerate: boolean;
  },
): Promise<GenerateContentResult> {
  if (opts.releaseIds.length === 0) return { scanned: 0, generated: 0 };
  try {
    const { body } = await requestJson(fetchImpl, `${opts.apiUrl}/v1/workflows/generate-content`, {
      method: "POST",
      token: opts.token,
      body: {
        sourceId: opts.sourceId,
        releaseIds: opts.releaseIds,
        regenerate: opts.regenerate,
        dryRun: false,
        limit: 100,
      },
    });
    const parsed = body as { scanned?: number; generated?: number };
    return { scanned: Number(parsed.scanned ?? 0), generated: Number(parsed.generated ?? 0) };
  } catch (err) {
    if (err instanceof AuthError) return { skipped: "unauthorized" };
    throw err;
  }
}

export function isSourceId(source: string): boolean {
  return source.trim().startsWith("src_");
}

export function idsForUrls(listed: ListedRelease[], urls: string[]): string[] {
  const wanted = new Set(urls);
  const ids: string[] = [];
  for (const row of listed) {
    if (row.url && wanted.has(row.url)) ids.push(row.id);
  }
  return ids;
}
