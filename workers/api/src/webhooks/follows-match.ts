/** In-memory follow targets for one user — mirrors `/v1/me/feed` matching. */
export interface UserFollowTargets {
  orgIds: Set<string>;
  productIds: Set<string>;
}

export interface ReleaseFollowOwner {
  orgId: string;
  productId: string | null;
}

/** Same predicate as `getFollowedReleases`: org follow OR product follow. */
export function releaseMatchesFollows(
  owner: ReleaseFollowOwner,
  follows: UserFollowTargets,
): boolean {
  if (follows.orgIds.has(owner.orgId)) return true;
  if (owner.productId && follows.productIds.has(owner.productId)) return true;
  return false;
}

export function emptyFollowTargets(): UserFollowTargets {
  return { orgIds: new Set(), productIds: new Set() };
}

/** Fold `user_follows` rows into per-user target sets. */
export function foldUserFollowRows(
  rows: Array<{ userId: string; targetType: string; targetId: string }>,
): Map<string, UserFollowTargets> {
  const out = new Map<string, UserFollowTargets>();
  for (const row of rows) {
    let targets = out.get(row.userId);
    if (!targets) {
      targets = emptyFollowTargets();
      out.set(row.userId, targets);
    }
    if (row.targetType === "org") targets.orgIds.add(row.targetId);
    else if (row.targetType === "product") targets.productIds.add(row.targetId);
  }
  return out;
}
