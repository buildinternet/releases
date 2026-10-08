import { getApiUrl, getApiKey, isAdminMode } from "../lib/mode.js";
import { shouldRecordMutation, recordMutation } from "../lib/mutation-log.js";
import { newIdempotencyKey, shouldSendIdempotencyKey } from "../lib/idempotency.js";
import { RELEASES_CLI_UA } from "../lib/user-agent.js";
import { ApiError, apiErrorMessage } from "../lib/errors.js";
import { assertSafePath } from "../lib/validate-input.js";
import type { LatestRelease, MediaItem } from "./types.js";
import { type ListResponse } from "@buildinternet/releases-core/cli-contracts";

export type {
  DomainLookupResponse,
  OverviewCitation,
  OverviewInputsCheck,
  OverviewManifestResponse,
  OverviewManifestRow,
  OverviewPlanAction,
  OverviewStaleness,
  CollectionListItem,
  CollectionDetail,
  CollectionMemberInput,
  CollectionRow,
} from "@buildinternet/releases-api-types";
export type {
  SourceWithOrg,
  SourcePatchInput,
  ReleaseWithSource,
  StatsSummary,
  FetchLogEntry,
  ActiveFetchSession,
  LatestRelease,
  UsageBreakdownRow,
  UsageStatsResponse,
  Session,
  EmbedBackfillResponse,
  EmbedStatusResponse,
  EvaluationResult,
  Stats,
  SourceListItem,
  OrgDependentsResponse,
} from "./types.js";

// OpenSSL verification-failure codes Bun's fetch surfaces when the server's
// chain doesn't anchor to a trusted CA — the signature of a TLS-intercepting
// proxy whose CA isn't in the bundled Mozilla store.
const CERT_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

function isCertVerificationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && CERT_ERROR_CODES.has(code);
}

export interface ApiFetchOpts extends RequestInit {
  /**
   * Skip the default admin-mode Authorization header even when a credential
   * is configured. Set this when the caller supplies its own `Authorization`
   * header (e.g. a session-scoped Bearer token) that must not be clobbered by
   * the static admin/API key — see `keysRequest` in `cli/commands/keys.ts`.
   */
  skipDefaultAuth?: boolean;
}

export async function apiFetch<T>(path: string, opts?: ApiFetchOpts): Promise<T> {
  // Defense-in-depth: reject raw control characters in the assembled path. By
  // this point user identifiers are already percent-encoded, so a clean path
  // never contains them — this only catches anything that bypassed the
  // raw-input validation in the entity resolvers.
  assertSafePath(path);
  const url = `${getApiUrl()}${path}`;
  // Empty string when no method is set — `shouldRecordMutation` rejects it, so
  // GETs never log and the `method` field is a real verb whenever we do.
  const method = opts?.method ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": RELEASES_CLI_UA,
    ...(opts?.headers as Record<string, string>),
  };
  // Only send auth header when an API key is configured (admin mode). A
  // caller that already attached its own Authorization header (e.g. a
  // session-scoped Bearer token) can opt out via skipDefaultAuth so it isn't
  // clobbered by the static admin/API key.
  if (isAdminMode() && !opts?.skipDefaultAuth) {
    headers["Authorization"] = `Bearer ${getApiKey()}`;
  }
  // One key per logical call to `apiFetch` — this function makes no internal
  // retry attempts of its own, so "per invocation" and "per attempt" coincide
  // here. A caller that retries the same logical write (e.g. `keysRequest`'s
  // 401 reauth retry) generates its own key up front and reuses it instead of
  // calling through this helper twice. Header names are case-insensitive on
  // the wire, so match any casing — adding a second differently-cased header
  // would make fetch send both values comma-joined.
  const callerProvidedKey = Object.keys(headers).some(
    (name) => name.toLowerCase() === "idempotency-key",
  );
  if (shouldSendIdempotencyKey(method, path) && !callerProvidedKey) {
    headers["Idempotency-Key"] = newIdempotencyKey();
  }

  const logMutation = shouldRecordMutation(method, path);

  let res: Response;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped before the spread below
    const { skipDefaultAuth: _skipDefaultAuth, ...fetchOpts } = opts ?? {};
    res = await fetch(url, {
      ...fetchOpts,
      headers,
    });
  } catch (err) {
    // Transport-level failure (DNS, connection refused, abort) — no response,
    // but the mutating attempt still belongs in the audit trail.
    if (logMutation) {
      recordMutation({
        method,
        path,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const detail = err instanceof Error ? err.message : String(err);
    const hint = isCertVerificationError(err)
      ? " (TLS certificate verification failed — if you're behind a TLS-intercepting proxy, set NODE_EXTRA_CA_CERTS or SSL_CERT_FILE to the proxy's CA certificate)"
      : "";
    throw new Error(`API request failed on ${opts?.method ?? "GET"} ${path}: ${detail}${hint}`, {
      cause: err,
    });
  }

  if (res.status === 404 && (!opts?.method || opts.method === "GET")) return null as T;

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    const message =
      res.status === 409 && code === "idempotency_conflict"
        ? "This request was already submitted with a different payload. If you meant to retry, wait for the earlier request to finish or start a fresh invocation."
        : (apiErrorMessage(body) ?? res.statusText);
    if (logMutation) {
      recordMutation({ method, path, ok: false, status: res.status, error: message });
    }
    throw new ApiError({
      status: res.status,
      method: opts?.method ?? "GET",
      path,
      serverMessage: message,
    });
  }

  if (logMutation) {
    recordMutation({ method, path, ok: true, status: res.status });
  }

  // 204 No Content (e.g. DELETE) has an empty body; res.json() would throw.
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

export const SCOPE_RESOURCE = { org: "orgs", product: "products" } as const;

export function toMediaItems(
  raw: Array<{ type: string; url: string; alt?: string; r2Url?: string }> | undefined,
): MediaItem[] {
  return (raw ?? []).map((m) => ({
    type: m.type as MediaItem["type"],
    url: m.url,
    alt: m.alt,
    r2Url: m.r2Url,
  }));
}

// Common release-row wire shape shared by `/v1/releases/latest` and the
// org feed (`/v1/orgs/:slug/releases`). The org feed carries a few extra
// fields (prerelease, coverageCount, source.appStore) the CLI ignores, so
// declaring the narrower shape here is fine — `toLatestRelease` only reads
// what both endpoints return.
export type LatestReleaseWire = {
  id: string;
  version: string | null;
  title: string;
  summary: string | null;
  titleGenerated?: string | null;
  titleShort?: string | null;
  contentChars?: number | null;
  contentTokens?: number | null;
  /** AI-scored importance 1–5; `null`/absent means unscored, never "unimportant". */
  importance?: number | null;
  publishedAt: string | null;
  media: Array<{ type: string; url: string; alt?: string; r2Url?: string }>;
  source: { slug: string; name: string; type: string };
  product?: { slug: string; name: string } | null;
};

// `titleGenerated`/`titleShort`/`contentChars`/`contentTokens`/`importance` are
// carried so the shared renderer's description fallback chain and the slim
// JSON size hints have data without an extra round-trip. #215.
export function toLatestRelease(r: LatestReleaseWire): LatestRelease {
  return {
    id: r.id,
    title: r.title,
    version: r.version,
    publishedAt: r.publishedAt,
    sourceName: r.source.name,
    sourceSlug: r.source.slug,
    summary: r.summary ?? null,
    titleGenerated: r.titleGenerated ?? null,
    titleShort: r.titleShort ?? null,
    contentChars: r.contentChars ?? null,
    contentTokens: r.contentTokens ?? null,
    importance: r.importance ?? null,
    media: toMediaItems(r.media),
    product: r.product ?? null,
  };
}

export async function suggestEntities(
  endpoint: string,
  term: string,
  limit: number,
): Promise<Array<{ slug: string; name: string }>> {
  type Row = { slug: string; name: string };
  // /v1/orgs always returns a paginated envelope (#723); /v1/sources is bare
  // unless ?envelope=true. Accept either shape so this helper stays valid as
  // more list endpoints adopt always-envelope.
  const raw = (await apiFetch<Row[] | ListResponse<Row>>(`${endpoint}?limit=200`)) ?? ([] as Row[]);
  const all: Row[] = Array.isArray(raw) ? raw : raw.items;
  const lower = term.toLowerCase();
  return all
    .filter((e) => e.slug.includes(lower) || e.name.toLowerCase().includes(lower))
    .slice(0, limit);
}
