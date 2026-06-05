import { parseNotice } from "@buildinternet/releases-core/notice";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";
import { parseSelfDeclared } from "./self-declared.js";

/** Minimal shape of an organizations row the diff needs. */
export interface OrgLike {
  name: string;
  description: string | null;
  category: string | null;
  avatarUrl: string | null;
  metadata: string | null;
}

export interface OrgIdentityPlan {
  /** Direct column writes (name/description/category). Notice goes via metadata. */
  columnUpdates: Partial<{ name: string; description: string; category: string }>;
  /** New notice to merge into metadata, or undefined to leave as-is. */
  notice?: NonNullable<ReleasesJsonConfig["notice"]>;
  /** Remote image to mirror to R2, or undefined. */
  avatarSourceUrl?: string;
  /** Additive — never subject to no-clobber. */
  tagsToAdd: string[];
  socialsToAdd: { platform: string; handle: string }[];
  /** Single-value fields written this run (for the selfDeclared marker). */
  selfDeclaredFields: string[];
  /** Honored single-value fields skipped because a curator owns them or invalid. */
  skipped: string[];
}

export interface OrgReconcileDeps {
  /** Resolve a category input to a canonical slug, or null if invalid. */
  resolveCategory: (input: string) => string | null;
}

/** Single-value fields under the precedence rule. `notice`/`avatar` are stored
 *  off-column but follow the same rule via custom getters below. */
type SingleValueField = "name" | "description" | "category" | "avatar" | "notice";

export function computeOrgIdentityUpdates(
  org: OrgLike,
  config: ReleasesJsonConfig,
  deps: OrgReconcileDeps,
): OrgIdentityPlan {
  const marker = parseSelfDeclared(org.metadata);
  const declared = new Set(marker?.fields ?? []);
  const plan: OrgIdentityPlan = {
    columnUpdates: {},
    tagsToAdd: [],
    socialsToAdd: [],
    selfDeclaredFields: [...declared],
    skipped: [],
  };

  // Current emptiness per honored single-value field.
  const isEmpty: Record<SingleValueField, boolean> = {
    name: !org.name, // name is NOT NULL in the DB; effectively immutable unless previously self-declared
    description: !org.description,
    category: !org.category,
    avatar: !org.avatarUrl,
    notice: parseNotice(org.metadata) === null,
  };

  const writable = (field: SingleValueField) => isEmpty[field] || declared.has(field);

  const mark = (field: string) => {
    if (!plan.selfDeclaredFields.includes(field)) plan.selfDeclaredFields.push(field);
  };

  // name
  if (config.name !== undefined) {
    if (writable("name")) {
      plan.columnUpdates.name = config.name;
      mark("name");
    } else plan.skipped.push("name");
  }
  // description
  if (config.description !== undefined) {
    if (writable("description")) {
      plan.columnUpdates.description = config.description;
      mark("description");
    } else plan.skipped.push("description");
  }
  // category (validate first; invalid → skip the field, not the sync)
  if (config.category !== undefined) {
    const resolved = deps.resolveCategory(config.category);
    if (!resolved) plan.skipped.push("category");
    else if (writable("category")) {
      plan.columnUpdates.category = resolved;
      mark("category");
    } else plan.skipped.push("category");
  }
  // avatar
  if (config.avatar !== undefined) {
    if (writable("avatar")) {
      plan.avatarSourceUrl = config.avatar;
      mark("avatar");
    } else plan.skipped.push("avatar");
  }
  // notice
  if (config.notice !== undefined) {
    if (writable("notice")) {
      plan.notice = config.notice;
      mark("notice");
    } else plan.skipped.push("notice");
  }

  // Additive collections.
  if (config.tags) plan.tagsToAdd = [...config.tags];
  if (config.social) {
    for (const [platform, handle] of Object.entries(config.social)) {
      plan.socialsToAdd.push({ platform, handle });
    }
  }

  return plan;
}
