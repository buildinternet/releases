import type { DeclaredLocation } from "./materialize.js";
import { normalizeUrl } from "./materialize.js";

/**
 * Normalize a `github` locator ("owner/repo") for comparison — lowercased,
 * `.git` suffix stripped. Mirrors the coordinate normalization in
 * materialize.ts so a locator's match_key lines up with the promotion-time
 * dedup key.
 */
function normalizeGithub(value: string): string {
  const [owner, repo] = value.split("/");
  if (!owner || !repo) return value.toLowerCase();
  return `${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase();
}

/**
 * Deterministic dedup key for a declared release location, stored on
 * `release_locations.match_key` and backing the per-org `UNIQUE(org_id,
 * match_key)` constraint.
 *
 * Precedence follows the locator discriminator order (feed ?? github ??
 * appstore ?? file ?? url) — the same order `classifyLocation()` uses to pick a
 * single fetch route — then prefixes the field name so a `feed` and a bare
 * `url` pointing at the same string stay distinct declared facts. Every value
 * is normalized (URL host lowercased / trailing slash + hash stripped; github
 * coordinate lowercased) so re-declaration of the same target collapses onto
 * one row.
 *
 * Determinism matters beyond dedup: #1871's byte-identical git export projects
 * these rows, so the key must be a pure function of the locator with stable
 * output. `self` never reaches here — stubs are built from domain manifests /
 * curator input, whose github locators are always `owner/repo`.
 */
export function releaseLocationMatchKey(location: DeclaredLocation): string {
  if (location.feed) return `feed:${normalizeUrl(location.feed)}`;
  if (location.github && location.github !== "self") {
    return `github:${normalizeGithub(location.github)}`;
  }
  if (location.appstore) return `appstore:${normalizeUrl(location.appstore)}`;
  if (location.file) return `file:${normalizeUrl(location.file)}`;
  if (location.url) return `url:${normalizeUrl(location.url)}`;
  // The schema's ≥1-locator refinement makes this unreachable; return a stable
  // sentinel rather than throw so a malformed row can't crash a batch.
  return "invalid:";
}
