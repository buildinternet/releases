import { and, eq } from "drizzle-orm";
import { sources, products } from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import {
  ReleasesJsonConfigSchema,
  type ReleasesJsonConfig,
} from "@buildinternet/releases-api-types";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { createDb } from "../../db.js";
import { logEvent } from "@releases/lib/log-event";
import { fetchReleasesJson } from "./fetch.js";
import { parseSelfDeclared, setSelfDeclaredInMetadata, configHash } from "./self-declared.js";

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/** Extract `owner/repo` from a github.com source URL. Returns null otherwise.
 *  owner/repo are charset-validated so they're safe to interpolate into the raw
 *  content URL later (defense-in-depth against path/host injection). */
export function parseGitHubRepo(url: string): GitHubRepo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  const segs = parsed.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  // GitHub owner/repo slugs are limited to [A-Za-z0-9._-]; reject anything else.
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

export interface ProductRowLike {
  id: string;
  slug: string;
  description: string | null;
  category: string | null;
  kind: string | null;
}

export interface SourceRowLike {
  productId: string | null;
  metadata: string | null;
}

export interface ProductPlan {
  /** Create a new product with these values (omitted when one already matches). */
  create?: {
    name: string;
    slug: string;
    description: string | null;
    category: string | null;
    kind: string | null;
  };
  /** Set source.productId to the matched/created product. */
  attach: boolean;
  /** Fill-if-empty updates to an existing product. */
  fills: Partial<{ description: string; category: string; kind: string }>;
  /** The product slug this plan targets (for the apply step's find-or-create). */
  slug?: string;
}

export interface SourceReconcileDeps {
  resolveCategory: (input: string) => string | null;
}

/**
 * @param existing the product row matching the declared slug within the org, or null
 */
export function computeProductPlan(
  existing: ProductRowLike | null,
  source: SourceRowLike,
  config: ReleasesJsonConfig,
  deps: SourceReconcileDeps,
): ProductPlan {
  const product = config.product;
  if (!product) return { attach: false, fills: {} };

  const slug = product.slug ? toSlug(product.slug) : toSlug(product.name);
  const category = product.category ? deps.resolveCategory(product.category) : null;

  // Attach decision: ok if source has no product, or its product was self-declared.
  const marker = parseSelfDeclared(source.metadata);
  const productSelfDeclared = marker?.fields.includes("product") ?? false;
  const attach = source.productId === null || productSelfDeclared;

  if (!existing) {
    return {
      create: {
        name: product.name,
        slug,
        description: product.description ?? null,
        category: category ?? null,
        kind: product.kind ?? null,
      },
      attach,
      fills: {},
      slug,
    };
  }

  const fills: ProductPlan["fills"] = {};
  if (product.description && !existing.description) fills.description = product.description;
  if (category && !existing.category) fills.category = category;
  if (product.kind && !existing.kind) fills.kind = product.kind;

  return { attach, fills, slug };
}

type Db = ReturnType<typeof createDb>;

export interface SyncSourceOptions {
  dryRun?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface SyncSourceResult {
  fetched: boolean;
  applied: boolean;
  skippedReason?: string;
  plan?: ProductPlan;
}

export async function syncSourceRepo(
  db: Db,
  sourceId: string,
  opts: SyncSourceOptions = {},
): Promise<SyncSourceResult> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) return { fetched: false, applied: false, skippedReason: "source_not_found" };
  if (source.type !== "github")
    return { fetched: false, applied: false, skippedReason: "not_github" };

  const gh = parseGitHubRepo(source.url);
  if (!gh) return { fetched: false, applied: false, skippedReason: "not_github" };

  const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/releases.json`;
  const fetched = await fetchReleasesJson(url, { fetchImpl: opts.fetchImpl });
  if (!fetched.ok) {
    logEvent("info", {
      component: "well-known",
      event: "repo-fetch-skip",
      sourceId,
      url,
      reason: fetched.reason,
    });
    return { fetched: false, applied: false, skippedReason: fetched.reason };
  }

  const validated = ReleasesJsonConfigSchema.safeParse(fetched.json);
  if (!validated.success) {
    logEvent("warn", { component: "well-known", event: "repo-validate-skip", sourceId, url });
    return { fetched: true, applied: false, skippedReason: "invalid_schema" };
  }
  const config = validated.data;
  if (!config.product) return { fetched: true, applied: false, skippedReason: "no_product" };

  const productSlug = config.product.slug
    ? toSlug(config.product.slug)
    : toSlug(config.product.name);
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.orgId, source.orgId), eq(products.slug, productSlug)));

  const resolved = config.product.category
    ? await resolveCategoryInput(db, config.product.category)
    : null;
  const plan = computeProductPlan(existing ?? null, source, config, {
    resolveCategory: (input) =>
      input === config.product?.category && resolved && resolved.ok ? resolved.slug : null,
  });

  if (opts.dryRun) return { fetched: true, applied: false, plan };

  // Resolve/create the product.
  let productId = existing?.id ?? null;
  let created = false;
  let filled = false;

  if (plan.create) {
    // Only materialize the product if we're also going to attach this source to
    // it. Otherwise (a curator-assigned source whose repo declares a brand-new
    // slug → attach=false) we'd leave an orphan product with no sources. Another
    // repo that DOES attach will create it.
    // TODO: if the sweep ever fans out concurrently, make this idempotent
    // (insert .onConflictDoNothing() then re-select) — UNIQUE(orgId, slug) would
    // otherwise throw on a concurrent double-create.
    if (plan.attach) {
      const [row] = await db
        .insert(products)
        .values({
          name: plan.create.name,
          slug: plan.create.slug,
          orgId: source.orgId,
          description: plan.create.description,
          category: plan.create.category,
          kind: plan.create.kind,
        })
        .returning({ id: products.id });
      productId = row!.id;
      created = true;
    }
  } else if (existing && Object.keys(plan.fills).length > 0) {
    await db.update(products).set(plan.fills).where(eq(products.id, existing.id));
    filled = true;
  }

  let attached = false;
  if (plan.attach && productId) {
    const metadata = setSelfDeclaredInMetadata(source.metadata, {
      fields: ["product"],
      source: "github",
      configHash: configHash(config),
      syncedAt: new Date().toISOString(),
    });
    await db.update(sources).set({ productId, metadata }).where(eq(sources.id, source.id));
    attached = true;
  }

  const applied = created || filled || attached;
  logEvent("info", {
    component: "well-known",
    event: "repo-applied",
    sourceId,
    productSlug,
    applied,
  });
  return { fetched: true, applied, plan };
}
