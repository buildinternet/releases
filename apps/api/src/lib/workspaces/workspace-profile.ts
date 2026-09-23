/**
 * Workspace (Better Auth organization) profile fields stored in `organization.metadata`
 * as JSON. Distinct from the registry `organizations` table.
 */
import { isPrivateOrLocalHost } from "./avatar-ingest.js";

export type WorkspaceProfileFields = {
  websiteUrl: string | null;
  changelogUrl: string | null;
  githubHandle: string | null;
};

const EMPTY: WorkspaceProfileFields = {
  websiteUrl: null,
  changelogUrl: null,
  githubHandle: null,
};

/** Parse the BA `metadata` column (JSON string or null) into profile fields. */
export function parseWorkspaceProfile(metadata: string | null | undefined): WorkspaceProfileFields {
  if (!metadata) return { ...EMPTY };
  try {
    const raw = JSON.parse(metadata) as Record<string, unknown>;
    return {
      websiteUrl: typeof raw.websiteUrl === "string" ? raw.websiteUrl : null,
      changelogUrl: typeof raw.changelogUrl === "string" ? raw.changelogUrl : null,
      githubHandle: typeof raw.githubHandle === "string" ? raw.githubHandle : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Merge profile field updates into existing metadata JSON. `null` clears a field. */
export function mergeWorkspaceMetadata(
  existing: string | null | undefined,
  patch: Partial<WorkspaceProfileFields>,
): string {
  const base = (() => {
    if (!existing) return {} as Record<string, unknown>;
    try {
      return JSON.parse(existing) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();

  for (const key of ["websiteUrl", "changelogUrl", "githubHandle"] as const) {
    if (key in patch) {
      const v = patch[key];
      if (v == null || v === "") delete base[key];
      else base[key] = v;
    }
  }
  return JSON.stringify(base);
}

const GITHUB_HANDLE_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/** Normalize a GitHub handle or profile/repo URL to a bare handle. */
export function normalizeGithubHandle(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const bare = trimmed.replace(/^@/, "");
  const looksLikeUrl = bare.includes("://") || bare.includes("github.com");
  if (looksLikeUrl) {
    try {
      const parsed = new URL(bare.includes("://") ? bare : `https://${bare}`);
      if (parsed.hostname.replace(/^www\./, "") !== "github.com") return null;
      const seg = parsed.pathname.split("/").filter(Boolean)[0];
      return seg && GITHUB_HANDLE_RE.test(seg) ? seg.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  if (!GITHUB_HANDLE_RE.test(bare)) return null;
  return bare.toLowerCase();
}

/** Validate a public https (or local http) URL for profile links. */
export function normalizeProfileUrl(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (isPrivateOrLocalHost(parsed.hostname)) return null;
  return parsed.toString();
}

type ProfilePatchResult =
  | { ok: true; patch: Partial<WorkspaceProfileFields> }
  | { ok: false; message: string };

/** Validate a PATCH body into normalized profile fields (partial). */
export function normalizeProfilePatch(body: {
  websiteUrl?: string | null;
  changelogUrl?: string | null;
  githubHandle?: string | null;
}): ProfilePatchResult {
  const patch: Partial<WorkspaceProfileFields> = {};
  for (const [key, label, normalize] of [
    ["websiteUrl", "websiteUrl", normalizeProfileUrl] as const,
    ["changelogUrl", "changelogUrl", normalizeProfileUrl] as const,
  ]) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw == null || raw === "") patch[key] = null;
    else {
      const value = normalize(raw);
      if (!value) return { ok: false, message: `${label} must be a valid public URL` };
      patch[key] = value;
    }
  }
  if ("githubHandle" in body) {
    if (body.githubHandle == null || body.githubHandle === "") patch.githubHandle = null;
    else {
      const handle = normalizeGithubHandle(body.githubHandle);
      if (!handle) {
        return { ok: false, message: "githubHandle must be a GitHub handle or profile URL" };
      }
      patch.githubHandle = handle;
    }
  }
  return { ok: true, patch };
}
