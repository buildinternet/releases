import { toSlug } from "@buildinternet/releases-core/slug";
import type { ReleasesJsonConfig } from "@buildinternet/releases-api-types";
import { parseSelfDeclared } from "./self-declared.js";

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
