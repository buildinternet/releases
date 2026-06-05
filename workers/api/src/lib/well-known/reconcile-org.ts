import { eq } from "drizzle-orm";
import { organizations, orgAccounts, orgTags } from "@buildinternet/releases-core/schema";
import { parseNotice, setNoticeInMetadata } from "@buildinternet/releases-core/notice";
import {
  ReleasesJsonConfigSchema,
  type ReleasesJsonConfig,
} from "@buildinternet/releases-api-types";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { ingestOrgAvatar } from "../avatar-ingest.js";
import { getOrCreateTagsD1 } from "../../utils.js";
import { createDb } from "../../db.js";
import { logEvent } from "@releases/lib/log-event";
import { fetchReleasesJson } from "./fetch.js";
import { parseSelfDeclared, setSelfDeclaredInMetadata, configHash } from "./self-declared.js";

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

type Db = ReturnType<typeof createDb>;

export interface SyncOrgOptions {
  bucket: R2Bucket;
  mediaOrigin: string;
  /** The org's domain; the file is fetched from https://{domain}/.well-known/releases.json. */
  domain: string | null;
  dryRun?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface SyncOrgResult {
  fetched: boolean;
  applied: boolean;
  skippedReason?: string;
  plan?: OrgIdentityPlan;
}

export async function syncOrgWellKnown(
  db: Db,
  orgId: string,
  opts: SyncOrgOptions,
): Promise<SyncOrgResult> {
  if (!opts.domain) return { fetched: false, applied: false, skippedReason: "no_domain" };

  // Defense-in-depth: the domain is interpolated into the URL, so reject any
  // value containing URL-special characters (/, @, #, ?, :, whitespace) before
  // constructing it. (fetchReleasesJson additionally enforces https + the
  // isPrivateOrLocalHost SSRF screen on the parsed host + manual redirects.)
  const domain = opts.domain.toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    logEvent("warn", {
      component: "well-known",
      event: "invalid-domain",
      orgId,
      domain: opts.domain,
    });
    return { fetched: false, applied: false, skippedReason: "invalid_domain" };
  }

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) return { fetched: false, applied: false, skippedReason: "org_not_found" };

  const url = `https://${domain}/.well-known/releases.json`;
  const fetched = await fetchReleasesJson(url, { fetchImpl: opts.fetchImpl });
  if (!fetched.ok) {
    logEvent("info", {
      component: "well-known",
      event: "fetch-skip",
      orgId,
      url,
      reason: fetched.reason,
    });
    return { fetched: false, applied: false, skippedReason: fetched.reason };
  }

  const validated = ReleasesJsonConfigSchema.safeParse(fetched.json);
  if (!validated.success) {
    logEvent("warn", {
      component: "well-known",
      event: "validate-skip",
      orgId,
      url,
      err: validated.error.message,
    });
    return { fetched: true, applied: false, skippedReason: "invalid_schema" };
  }
  const config = validated.data;

  // Hash is order-sensitive; a schema field-order change can cause a one-time
  // spurious re-apply on the next sweep (idempotent, harmless).
  const hash = configHash(config);
  const existing = parseSelfDeclared(org.metadata);
  if (existing && existing.source === "well-known" && existing.configHash === hash) {
    return { fetched: true, applied: false, skippedReason: "unchanged" };
  }

  const resolvedCategory = config.category ? await resolveCategoryInput(db, config.category) : null;
  const plan = computeOrgIdentityUpdates(org, config, {
    resolveCategory: (input) =>
      input === config.category && resolvedCategory && resolvedCategory.ok
        ? resolvedCategory.slug
        : null,
  });

  if (opts.dryRun) return { fetched: true, applied: false, plan };

  // Avatar mirror (best-effort; a failure must not fail the sync).
  let avatarUrl: string | undefined;
  if (plan.avatarSourceUrl) {
    const result = await ingestOrgAvatar({
      sourceUrl: plan.avatarSourceUrl,
      slug: org.slug,
      bucket: opts.bucket,
      mediaOrigin: opts.mediaOrigin,
      fetchImpl: opts.fetchImpl,
    });
    if (result.ok) avatarUrl = result.avatarUrl;
    else
      logEvent("info", {
        component: "well-known",
        event: "avatar-skip",
        orgId,
        reason: result.error,
      });
  }

  // Compose metadata: notice (if any) + the selfDeclared provenance marker.
  let metadata = org.metadata ?? "{}";
  if (plan.notice !== undefined) metadata = setNoticeInMetadata(metadata, plan.notice);
  metadata = setSelfDeclaredInMetadata(metadata, {
    fields: plan.selfDeclaredFields,
    source: "well-known",
    configHash: hash,
    syncedAt: new Date().toISOString(),
  });

  await db
    .update(organizations)
    .set({
      ...plan.columnUpdates,
      ...(avatarUrl ? { avatarUrl } : {}),
      metadata,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(organizations.id, org.id));

  // Additive tags.
  if (plan.tagsToAdd.length > 0) {
    const tagRows = await getOrCreateTagsD1(db, plan.tagsToAdd);
    const now = new Date().toISOString();
    await db
      .insert(orgTags)
      .values(tagRows.map((t) => ({ orgId: org.id, tagId: t.id, createdAt: now })))
      .onConflictDoNothing();
  }
  // Additive socials — single batched insert (mirrors the tag insert above).
  if (plan.socialsToAdd.length > 0) {
    const socialNow = new Date().toISOString();
    await db
      .insert(orgAccounts)
      .values(
        plan.socialsToAdd.map((s) => ({
          orgId: org.id,
          platform: s.platform,
          handle: s.handle,
          createdAt: socialNow,
        })),
      )
      .onConflictDoNothing();
  }

  logEvent("info", {
    component: "well-known",
    event: "org-applied",
    orgId,
    fields: plan.selfDeclaredFields,
  });
  return { fetched: true, applied: true, plan };
}
