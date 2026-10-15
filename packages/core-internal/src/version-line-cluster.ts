/**
 * Group release candidates, backports, and sibling-package releases that
 * describe one launch. Content-hash dedup leaves these rows in place (they
 * are different versions or packages); this clusterer links the extras as
 * coverage so the feed shows one item.
 *
 * Conservative on purpose. A pair links only on a structural signal:
 * prerelease → stable on one source, the same normalized body on two version
 * lines of one source within a few weeks, or the same body and version across
 * sibling packages on the same day. Unrelated same-day posts stay separate.
 */
import { isPrereleaseVersion } from "@buildinternet/releases-core/prerelease";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import {
  publishedDay,
  versionIdentity,
  type VersionIdentity,
} from "@buildinternet/releases-core/content-dedup";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An rc and its stable ship weeks apart; beyond a season they are different launches. */
const RC_WINDOW_MS = 120 * DAY_MS;
/** A backport of the same notes lands with the main release, not months later. */
const BACKPORT_WINDOW_MS = 21 * DAY_MS;

export interface VersionLineInput {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  publishedAt: string | null;
  /** sha256 of the normalized body, or null when the body is too short to compare. */
  bodyHash: string | null;
}

export interface VersionLineCluster {
  canonicalId: string;
  coverageIds: string[];
  reason: string;
}

interface Annotated extends VersionLineInput {
  identity: VersionIdentity | null;
  /** Semver core (`1.2.0`) when the row has a version token. */
  base: string | null;
  prerelease: boolean;
  sort: string | null;
  time: number | null;
  day: string | null;
}

function annotate(row: VersionLineInput): Annotated {
  const identity = versionIdentity(row.version, row.title);
  const token = identity?.token ?? null;
  const base = token ? (/^(\d+\.\d+\.\d+)/.exec(token)?.[1] ?? null) : null;
  const versionForSort = token ?? row.version;
  const time = row.publishedAt ? Date.parse(row.publishedAt) : NaN;
  return {
    ...row,
    identity,
    base,
    prerelease: isPrereleaseVersion(token ?? row.version),
    sort: computeVersionSort(versionForSort),
    time: Number.isNaN(time) ? null : time,
    day: publishedDay(row.publishedAt),
  };
}

function byCanonicalRank(a: Annotated, b: Annotated): number {
  if (a.sort && b.sort && a.sort !== b.sort) return a.sort < b.sort ? 1 : -1;
  if (a.sort && !b.sort) return -1;
  if (!a.sort && b.sort) return 1;
  if (b.content.length !== a.content.length) return b.content.length - a.content.length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function spanWithin(rows: Annotated[], windowMs: number): boolean {
  const times = rows.map((r) => r.time).filter((t): t is number => t != null);
  if (times.length <= 1) return true;
  return Math.max(...times) - Math.min(...times) <= windowMs;
}

function emit(
  members: Annotated[],
  reason: string,
  assigned: Set<string>,
  rank: (rows: Annotated[]) => Annotated[],
): VersionLineCluster | null {
  const free = members.filter((m) => !assigned.has(m.id));
  if (free.length < 2) return null;
  const ordered = rank(free);
  const canonical = ordered[0];
  if (!canonical) return null;
  const coverageIds = ordered.slice(1).map((m) => m.id);
  if (coverageIds.length === 0) return null;
  assigned.add(canonical.id);
  for (const id of coverageIds) assigned.add(id);
  return { canonicalId: canonical.id, coverageIds, reason };
}

/**
 * Cluster a set of releases (one batch plus the nearby rows it might attach
 * to). Pure: same input → same output. Each release appears in at most one
 * cluster. Single-release groups are omitted.
 */
export function clusterVersionLines(rows: VersionLineInput[]): VersionLineCluster[] {
  if (rows.length < 2) return [];
  const annotated = rows.map(annotate);
  const assigned = new Set<string>();
  const clusters: VersionLineCluster[] = [];

  // Release candidates: same source, same semver core, at least one prerelease.
  const rcGroups = new Map<string, Annotated[]>();
  for (const row of annotated) {
    if (!row.base) continue;
    const key = `${row.sourceId}|${row.base}`;
    const list = rcGroups.get(key) ?? [];
    list.push(row);
    rcGroups.set(key, list);
  }
  for (const [key, members] of rcGroups) {
    if (!members.some((m) => m.prerelease)) continue;
    if (!spanWithin(members, RC_WINDOW_MS)) continue;
    const cluster = emit(members, `version-line:rc:${key.split("|")[1]}`, assigned, (free) =>
      free.toSorted(byCanonicalRank),
    );
    if (cluster) clusters.push(cluster);
  }

  // Backports: same source, same body, different semver cores, within a few weeks.
  const backportGroups = new Map<string, Annotated[]>();
  for (const row of annotated) {
    if (!row.bodyHash || !row.base || assigned.has(row.id)) continue;
    const key = `${row.sourceId}|${row.bodyHash}`;
    const list = backportGroups.get(key) ?? [];
    list.push(row);
    backportGroups.set(key, list);
  }
  for (const [, members] of backportGroups) {
    const bases = new Set(members.map((m) => m.base));
    if (bases.size < 2) continue;
    const dated = members.filter((m) => m.time != null);
    if (dated.length < 2) continue;
    const newest = Math.max(...dated.map((m) => m.time!));
    const windowed = members.filter(
      (m) => m.time != null && newest - m.time! <= BACKPORT_WINDOW_MS,
    );
    if (new Set(windowed.map((m) => m.base)).size < 2) continue;
    const cluster = emit(
      windowed,
      `version-line:backport:${[...new Set(windowed.map((m) => m.base))].toSorted().join("+")}`,
      assigned,
      (free) => free.toSorted(byCanonicalRank),
    );
    if (cluster) clusters.push(cluster);
  }

  // Sibling packages: same version core, same body, same day, different package or source.
  const siblingGroups = new Map<string, Annotated[]>();
  for (const row of annotated) {
    if (!row.bodyHash || !row.base || !row.day || assigned.has(row.id)) continue;
    const key = `${row.day}|${row.base}|${row.bodyHash}`;
    const list = siblingGroups.get(key) ?? [];
    list.push(row);
    siblingGroups.set(key, list);
  }
  for (const [, members] of siblingGroups) {
    const sources = new Set(members.map((m) => m.sourceId));
    const packages = new Set(
      members.map((m) => m.identity?.packageName).filter((p): p is string => !!p),
    );
    if (sources.size < 2 && packages.size < 2) continue;
    const cluster = emit(members, `version-line:sibling:${members[0]!.base}`, assigned, (free) =>
      free.toSorted((a, b) => {
        if (b.content.length !== a.content.length) return b.content.length - a.content.length;
        if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1;
        return a.id < b.id ? -1 : 1;
      }),
    );
    if (cluster) clusters.push(cluster);
  }

  return clusters;
}
