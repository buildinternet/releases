/**
 * Pure parser for GitHub-style "org/repo" coordinates. Centralized here so
 * the search routes, MCP tools, and the lookup handler all agree on what
 * counts as a parseable coordinate. Future providers (npm, GitLab, PyPI)
 * extend the discriminated union — they don't fork the regex.
 */

export type Coordinate = { provider: "github"; org: string; repo: string };

const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseCoordinate(input: string): Coordinate | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [org, repo] = parts;
  if (!org || !repo) return null;
  if (!GITHUB_SEGMENT.test(org) || !GITHUB_SEGMENT.test(repo)) return null;
  return { provider: "github", org, repo };
}
