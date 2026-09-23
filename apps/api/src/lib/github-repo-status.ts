import {
  type ReleasesError,
  NotFoundError,
  ServiceUnavailableError,
  UpstreamError,
} from "@releases/lib/releases-error";

/**
 * Pre-flight check for "can we actually read this GitHub repo right now?",
 * shared by the changelog probe (source-scoped) and the changelog fetch
 * (coordinate-based) routes.
 *
 * The CHANGELOG planner (`discoverChangelogPaths`) swallows every upstream
 * failure into an empty result, so on its own a caller can't tell "no
 * CHANGELOG found" apart from "we couldn't reach the repo." A single
 * `GET /repos/:owner/:repo` up front disambiguates the four states callers
 * care about:
 *
 * - 404 → repo doesn't exist            → respond 404
 * - 401 → auth failure                  → respond 502
 * - 403 → rate-limit OR auth/permission → 503 if x-ratelimit-remaining is 0,
 *                                         else 502 (GitHub overloads 403)
 * - 429 → rate-limited                  → respond 503
 * - 5xx / network error                 → respond 502
 */
export type RepoStatus = { kind: "ok" } | { kind: "fail"; error: ReleasesError };

/** GitHub 5xx / auth / network → upstream (502); message hidden by expose:false. */
function upstream(message: string): ReleasesError {
  return new UpstreamError(message, { details: { upstream: "github" } });
}

export async function classifyRepoStatus(
  ownerRepo: { owner: string; repo: string },
  apiHeaders: Record<string, string>,
): Promise<RepoStatus> {
  const { owner, repo } = ownerRepo;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: apiHeaders });
  } catch (err) {
    return {
      kind: "fail",
      error: upstream(`GitHub network error: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
  if (res.ok) return { kind: "ok" };
  if (res.status === 404) {
    return { kind: "fail", error: new NotFoundError(`${owner}/${repo} not found on GitHub`) };
  }
  if (res.status === 401) {
    return { kind: "fail", error: upstream(`GitHub returned ${res.status} for ${owner}/${repo}`) };
  }
  // 403 is ambiguous: GitHub returns it for primary rate-limit exhaustion
  // (with x-ratelimit-remaining: 0) as well as auth/permission failures. Treat
  // the rate-limit case as retryable (503); everything else as auth (502).
  if (res.status === 403) {
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      return { kind: "fail", error: new ServiceUnavailableError("GitHub rate limit exceeded") };
    }
    return { kind: "fail", error: upstream(`GitHub returned ${res.status} for ${owner}/${repo}`) };
  }
  if (res.status === 429) {
    return { kind: "fail", error: new ServiceUnavailableError("GitHub rate limit exceeded") };
  }
  return { kind: "fail", error: upstream(`GitHub returned ${res.status} for ${owner}/${repo}`) };
}
