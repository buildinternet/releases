import {
  RELEASE_TYPES,
  type ReleaseType,
  type WebhookSubscription,
} from "@buildinternet/releases-core/schema";
import type { UserFollowTargets } from "./follows-match.js";
import { releaseMatchesFollows } from "./follows-match.js";

export interface WebhookEventOwner {
  orgId: string;
  sourceId: string;
  productId: string | null;
  releaseType: ReleaseType;
}

export function parseReleaseTypeFilter(value: unknown): ReleaseType | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "invalid";
  return (RELEASE_TYPES as readonly string[]).includes(value) ? (value as ReleaseType) : "invalid";
}

export function orgSubscriptionMatchesEvent(
  sub: WebhookSubscription,
  owner: WebhookEventOwner,
): boolean {
  if (sub.scope === "follows") return false;
  if (!sub.orgId || sub.orgId !== owner.orgId) return false;
  if (sub.sourceId != null && sub.sourceId !== owner.sourceId) return false;
  if (sub.productId != null && sub.productId !== owner.productId) return false;
  if (sub.releaseType != null && sub.releaseType !== owner.releaseType) return false;
  return true;
}

export function followsSubscriptionMatchesEvent(
  sub: WebhookSubscription,
  owner: WebhookEventOwner,
  follows: UserFollowTargets,
): boolean {
  if (sub.scope !== "follows" || !sub.userId) return false;
  if (!releaseMatchesFollows(owner, follows)) return false;
  if (sub.releaseType != null && sub.releaseType !== owner.releaseType) return false;
  return true;
}
