/**
 * Pure parser for GitHub-style "org/repo" coordinates. Centralized here so
 * the search routes, MCP tools, and the lookup handler all agree on what
 * counts as a parseable coordinate. Future providers (npm, GitLab, PyPI)
 * extend the discriminated union — they don't fork the regex.
 */

export type Coordinate = { provider: "github"; org: string; repo: string };

const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseCoordinate(input: string): Coordinate | null {
  let trimmed = input.trim();
  if (!trimmed) return null;
  // Optional `github:` prefix — symmetry with how /v1/lookups accepts
  // `{ provider, coordinate }` separately. Other provider prefixes
  // (npm:, gitlab:, …) return null so we don't silently pretend to
  // support them.
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx >= 0) {
    if (trimmed.slice(0, colonIdx).toLowerCase() !== "github") return null;
    trimmed = trimmed.slice(colonIdx + 1);
  }
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [org, repo] = parts;
  if (!org || !repo) return null;
  if (!GITHUB_SEGMENT.test(org) || !GITHUB_SEGMENT.test(repo)) return null;
  return { provider: "github", org, repo };
}
