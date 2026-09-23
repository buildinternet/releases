/** Provenance marker stored at `metadata.selfDeclared` on orgs and sources. */
export interface SelfDeclared {
  /** Single-value fields this reconciler last wrote from the owner file. */
  fields: string[];
  /** Which host the authoritative file came from. */
  source: "well-known" | "github";
  /** Hash of the last applied file, to short-circuit unchanged re-syncs. */
  configHash: string;
  /** ISO timestamp of the last successful apply. */
  syncedAt: string;
}

export function parseSelfDeclared(metadata: string | null | undefined): SelfDeclared | null {
  if (!metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = (parsed as Record<string, unknown>).selfDeclared;
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.fields) || !s.fields.every((f) => typeof f === "string")) return null;
  if (s.source !== "well-known" && s.source !== "github") return null;
  if (typeof s.configHash !== "string" || typeof s.syncedAt !== "string") return null;
  return {
    fields: s.fields as string[],
    source: s.source,
    configHash: s.configHash,
    syncedAt: s.syncedAt,
  };
}

export function setSelfDeclaredInMetadata(
  metadata: string | null | undefined,
  marker: SelfDeclared,
): string {
  let base: Record<string, unknown> = {};
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed === "object" && parsed !== null) base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  base.selfDeclared = marker;
  return JSON.stringify(base);
}

/**
 * Central owner-declared metadata merge. All reconcilers use this helper so a
 * later basis/provenance migration has one write boundary to replace.
 */
export function mergeSelfDeclaredMetadata(
  metadata: string | null | undefined,
  input: Omit<SelfDeclared, "syncedAt"> & { declared?: Record<string, unknown> },
): string {
  let base: Record<string, unknown> = {};
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed === "object" && parsed !== null) base = parsed as Record<string, unknown>;
    } catch {
      // Malformed metadata is treated as empty, matching the existing setter.
    }
  }
  if (input.declared) {
    const current =
      typeof base.declared === "object" && base.declared !== null
        ? (base.declared as Record<string, unknown>)
        : {};
    base.declared = { ...current, ...input.declared };
  }
  return setSelfDeclaredInMetadata(JSON.stringify(base), {
    fields: [...new Set(input.fields)],
    source: input.source,
    configHash: input.configHash,
    syncedAt: new Date().toISOString(),
  });
}

/** Stable FNV-1a hash of a config object's JSON. Key order is significant. */
export function configHash(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
