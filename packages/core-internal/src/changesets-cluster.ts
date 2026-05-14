/**
 * Detect changesets-style cascade releases within a batch from one source.
 *
 * Changesets monorepos (Vercel, AI SDK, Turborepo, …) emit one release per
 * package per commit. A single substantive change in a root package fans out
 * to N dependent packages whose bodies are just dependency-bump notes
 * referencing the same commit hash. Without grouping, one changeset
 * dominates the feed with 10–20 near-empty rows.
 *
 * This module groups those rows into a cluster: pick a canonical (the
 * release with the substantive body) and demote the rest to coverage rows
 * that fall out of `releases_visible`.
 *
 * Two cascade fingerprints:
 *
 * 1. Hash form — `Updated dependencies [HASH]`. The bracketed value is a
 *    git short-SHA (6–12 hex chars). Every release bumped by the same
 *    changeset shares the same hash.
 *
 * 2. Sibling form — `- @pkg@ver` with no hash. Transitive bumps that
 *    don't carry the hash directly; they reference the package whose bump
 *    triggered them. Resolved by walking the version index built from the
 *    same batch.
 */
export interface ClusterInput {
  id: string;
  /** changesets release title, also the version field — e.g. "@vercel/node@5.8.1" */
  version: string | null;
  content: string;
}

export interface ChangesetsCluster {
  hash: string;
  canonicalId: string;
  coverageIds: string[];
}

const UPDATED_DEPS_LINE = /^[\s>*-]*Updated dependencies\s+\[([0-9a-f]{6,12})\]/gim;
const SUBSTANTIVE_BULLET = /^[\s>*-]+([0-9a-f]{6,12}):\s+\S/gim;
// Package@version reference — `@scope/name@1.2.3` or `name@1.2.3`. Matches
// bullets that are a bare package reference (no description after).
const SIBLING_REF = /^[\s>*-]+(@?[\w.-]+(?:\/[\w.-]+)?@[\d][\w.+-]*)\s*$/gim;
const SECTION_HEADER = /^#{1,6}\s+(?:Patch|Minor|Major)\s+Changes\s*$/gim;
const UPDATED_DEPS_BLOCK =
  /^[\s>*-]*Updated dependencies\s+\[[0-9a-f]{6,12}\][^\n]*(?:\n[ \t]+[-*][^\n]+)*/gim;

interface ParsedRelease {
  id: string;
  version: string | null;
  content: string;
  /** Every hash mentioned anywhere in the body. */
  hashes: Set<string>;
  /** Hashes that appear as a substantive `HASH: description` bullet. */
  substantiveHashes: Set<string>;
  /** Bare `pkg@ver` bullets — transitive bump references. */
  siblingRefs: Set<string>;
  /** True if the body is all cascade noise (no real change description). */
  isPureCascade: boolean;
  /** Length of the body with cascade noise stripped — used to pick canonical. */
  substantiveLength: number;
}

function parseRelease(r: ClusterInput): ParsedRelease {
  const hashes = new Set<string>();
  const substantiveHashes = new Set<string>();
  const siblingRefs = new Set<string>();

  for (const m of r.content.matchAll(UPDATED_DEPS_LINE)) {
    hashes.add(m[1].toLowerCase());
  }
  for (const m of r.content.matchAll(SUBSTANTIVE_BULLET)) {
    const h = m[1].toLowerCase();
    hashes.add(h);
    substantiveHashes.add(h);
  }
  for (const m of r.content.matchAll(SIBLING_REF)) {
    siblingRefs.add(m[1]);
  }

  // Strip cascade noise and see what real content remains. We strip
  // section headers, "Updated dependencies [hash]" blocks (with indented
  // sub-bullets), and bare `pkg@ver` bullets. What remains is substantive
  // — used both to detect pure cascade rows and to pick the canonical
  // (highest substantive length wins).
  const stripped = r.content
    .replace(SECTION_HEADER, "")
    .replace(UPDATED_DEPS_BLOCK, "")
    .replace(SIBLING_REF, "")
    .replace(/\s+/g, "")
    .trim();
  const isPureCascade = stripped.length === 0;

  return {
    id: r.id,
    version: r.version,
    content: r.content,
    hashes,
    substantiveHashes,
    siblingRefs,
    isPureCascade,
    substantiveLength: stripped.length,
  };
}

/**
 * Cluster a batch of releases by changesets cascade structure.
 *
 * Returns one entry per detected cluster (hash, canonical, coverage). A
 * single-release "cluster" — no cascade siblings — is omitted; nothing to
 * group means nothing to demote.
 *
 * Pure: same input → same output, no IO, no DB.
 */
export function clusterChangesets(batch: ClusterInput[]): ChangesetsCluster[] {
  if (batch.length < 2) return [];

  const parsed = batch.map(parseRelease);

  // version field is `@vercel/node@5.8.1` — exactly the shape SIBLING_REF
  // captures. Used to resolve sibling-reference cascades to a release id.
  const versionToId = new Map<string, string>();
  for (const p of parsed) {
    if (p.version) versionToId.set(p.version, p.id);
  }

  // hash → release IDs that mention it
  const hashGroups = new Map<string, string[]>();
  for (const p of parsed) {
    for (const h of p.hashes) {
      const list = hashGroups.get(h) ?? [];
      list.push(p.id);
      hashGroups.set(h, list);
    }
  }

  const parsedById = new Map(parsed.map((p) => [p.id, p]));
  // releaseId → hash it's assigned to as canonical-or-coverage (one per release)
  const assignedHash = new Map<string, string>();
  const clusters = new Map<string, { canonicalId: string; coverageIds: Set<string> }>();

  // Pass 1: direct hash clusters (≥2 members per hash).
  // Order hashes by cluster size descending so the biggest cluster wins
  // when a release qualifies for multiple. Stable for tests.
  const sortedHashes = [...hashGroups.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .toSorted((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  for (const [hash, memberIds] of sortedHashes) {
    const members = memberIds
      .map((id) => parsedById.get(id))
      .filter((p): p is ParsedRelease => p !== undefined);

    // Canonical = release with substantive bullet for this hash. If
    // multiple, take the longest *substantive* content (cascade noise
    // stripped) — raw-length would favor rows whose Updated-deps blocks
    // pad them out. Falls back to longest substantive when no member is
    // substantive (rare — a hash with only Updated-deps refs).
    const substantive = members.filter((m) => m.substantiveHashes.has(hash));
    const pool = substantive.length > 0 ? substantive : members;
    const canonical = pool.reduce((a, b) => {
      // Primary: longest substantive (cascade-stripped) content. Tie-break
      // on raw length so the "all pure cascade" edge case still picks the
      // most informative row instead of the first one.
      if (b.substantiveLength !== a.substantiveLength) {
        return b.substantiveLength > a.substantiveLength ? b : a;
      }
      return b.content.length > a.content.length ? b : a;
    });

    const coverageIds = new Set<string>();
    for (const m of members) {
      if (m.id === canonical.id) continue;
      // Skip if already attached to a larger cluster.
      if (assignedHash.has(m.id)) continue;
      coverageIds.add(m.id);
      assignedHash.set(m.id, hash);
    }
    if (coverageIds.size === 0) continue;
    assignedHash.set(canonical.id, hash);
    clusters.set(hash, { canonicalId: canonical.id, coverageIds });
  }

  // Pass 2: transitive sibling resolution. A pure-cascade release with
  // `- @pkg@ver` bullets (no hash of its own) rolls up to whichever
  // cluster its sibling references resolve into. Walk at most 2 hops to
  // catch chains like @vercel/elysia → @vercel/node → cluster d874af6.
  const MAX_HOPS = 2;
  for (const p of parsed) {
    if (assignedHash.has(p.id)) continue;
    if (!p.isPureCascade) continue;
    if (p.siblingRefs.size === 0) continue;

    let targetHash: string | undefined;
    for (const ref of p.siblingRefs) {
      const hop = followSibling(ref, versionToId, parsedById, assignedHash, MAX_HOPS);
      if (hop) {
        targetHash = hop;
        break;
      }
    }
    if (!targetHash) continue;
    const cluster = clusters.get(targetHash);
    if (!cluster) continue;
    cluster.coverageIds.add(p.id);
    assignedHash.set(p.id, targetHash);
  }

  return [...clusters.entries()]
    .map(([hash, c]) => ({
      hash,
      canonicalId: c.canonicalId,
      coverageIds: [...c.coverageIds].toSorted(),
    }))
    .filter((c) => c.coverageIds.length > 0)
    .toSorted((a, b) => a.hash.localeCompare(b.hash));
}

/**
 * Follow a sibling reference (e.g. "@vercel/node@5.8.1") through the
 * version index to a hash cluster, walking at most `maxHops` hops. The
 * referenced sibling may itself be a pure-cascade row whose hash is
 * inherited from its own sibling — the chain bottoms out when we find a
 * release already assigned to a cluster, or we run out of hops.
 */
function followSibling(
  ref: string,
  versionToId: Map<string, string>,
  parsedById: Map<string, ParsedRelease>,
  assignedHash: Map<string, string>,
  maxHops: number,
): string | undefined {
  let current: string | undefined = versionToId.get(ref);
  for (let hop = 0; hop < maxHops; hop++) {
    if (!current) return undefined;
    const assigned = assignedHash.get(current);
    if (assigned) return assigned;
    const next = parsedById.get(current);
    if (!next) return undefined;
    // Take the first sibling reference; ordering is body-stable so this is
    // deterministic. We don't fan out — we just walk one chain.
    const nextRef = next.siblingRefs.values().next().value;
    if (!nextRef) return undefined;
    current = versionToId.get(nextRef);
  }
  return undefined;
}
