import { and, eq, isNull } from "drizzle-orm";
import { products, sources } from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import {
  ReleasesJsonRepoSchema,
  type ReleasesJsonDomain,
  type ReleasesJsonRepo,
} from "@buildinternet/releases-api-types";
import { createDb } from "../../db.js";
import { logEvent } from "@releases/lib/log-event";
import { fetchReleasesJson } from "./fetch.js";
import { configHash, mergeSelfDeclaredMetadata, parseSelfDeclared } from "./self-declared.js";
import {
  locationMatchesSource,
  reconcileDomainEntities,
  type EntityMaterializationPlan,
  type MaterializationOptions,
} from "./materialize.js";

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/** Extract a validated `owner/repo` from a github.com source URL. */
export function parseGitHubRepo(url: string): GitHubRepo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

type Db = ReturnType<typeof createDb>;

export interface RepoProductBindingPlan {
  productId?: string;
  matchBy?: "stable_id" | "locator" | "slug" | "current";
  attach: boolean;
}

export interface RepoReconcilePlan extends EntityMaterializationPlan {
  productBinding: RepoProductBindingPlan;
}

export interface SyncSourceOptions {
  dryRun?: boolean;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  materializationEnabled?: boolean;
  githubToken?: string;
  probe?: MaterializationOptions["probe"];
}

export interface SyncSourceResult {
  fetched: boolean;
  applied: boolean;
  skippedReason?: string;
  plan?: RepoReconcilePlan;
}

function repoManifestAsDomain(
  config: ReleasesJsonRepo,
  coordinate: string,
  targetProduct: typeof products.$inferSelect | undefined,
): ReleasesJsonDomain {
  const releases = config.releases?.map((location) =>
    location.github === "self" ? { ...location, github: coordinate } : location,
  );
  if (config.product || targetProduct) {
    const slug = config.product?.slug ?? targetProduct?.slug;
    return {
      version: 2,
      products: [
        {
          name: config.product?.name ?? targetProduct!.name,
          ...(slug ? { slug } : {}),
          releases,
        },
      ],
      registries: targetProduct ? { "releases.sh": { product: targetProduct.id } } : undefined,
    };
  }
  return { version: 2, releases };
}

export async function syncSourceRepo(
  db: Db,
  sourceId: string,
  opts: SyncSourceOptions = {},
): Promise<SyncSourceResult> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) return { fetched: false, applied: false, skippedReason: "source_not_found" };
  if (source.type !== "github") {
    return { fetched: false, applied: false, skippedReason: "not_github" };
  }

  const github = parseGitHubRepo(source.url);
  if (!github) return { fetched: false, applied: false, skippedReason: "not_github" };
  const coordinate = `${github.owner}/${github.repo}`;
  const url = `https://raw.githubusercontent.com/${coordinate}/HEAD/releases.json`;
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

  const validated = ReleasesJsonRepoSchema.safeParse(fetched.json);
  if (!validated.success) {
    logEvent("warn", {
      component: "well-known",
      event: "repo-validate-skip",
      sourceId,
      url,
      err: validated.error.message,
    });
    return { fetched: true, applied: false, skippedReason: "invalid_schema" };
  }
  const config = validated.data;
  const hash = configHash(config);
  const marker = parseSelfDeclared(source.metadata);
  if (marker?.source === "github" && marker.configHash === hash) {
    return { fetched: true, applied: false, skippedReason: "unchanged" };
  }

  const orgProducts = await db
    .select()
    .from(products)
    .where(and(eq(products.orgId, source.orgId), isNull(products.deletedAt)));
  const orgSources = await db
    .select()
    .from(sources)
    .where(and(eq(sources.orgId, source.orgId), isNull(sources.deletedAt)));
  const stableId = config.registries?.["releases.sh"]?.product;
  const locatorProductId = config.releases
    ?.map((location) => {
      const concrete = location.github === "self" ? { ...location, github: coordinate } : location;
      return orgSources.find((candidate) => locationMatchesSource(concrete, candidate))?.productId;
    })
    .find(Boolean);
  const slug = config.product ? toSlug(config.product.slug ?? config.product.name) : undefined;
  const targetProduct =
    (stableId ? orgProducts.find((product) => product.id === stableId) : undefined) ??
    (locatorProductId
      ? orgProducts.find((product) => product.id === locatorProductId)
      : undefined) ??
    (slug ? orgProducts.find((product) => product.slug === slug) : undefined) ??
    (source.productId ? orgProducts.find((product) => product.id === source.productId) : undefined);
  const matchBy: RepoProductBindingPlan["matchBy"] =
    stableId && targetProduct?.id === stableId
      ? "stable_id"
      : locatorProductId && targetProduct?.id === locatorProductId
        ? "locator"
        : slug && targetProduct?.slug === slug
          ? "slug"
          : targetProduct
            ? "current"
            : undefined;

  const synthetic = repoManifestAsDomain(config, coordinate, targetProduct);
  const entities = await reconcileDomainEntities(db, source.orgId, synthetic, {
    dryRun: opts.dryRun === true,
    enabled: opts.materializationEnabled !== false,
    source: "github",
    fetchImpl: opts.fetchImpl as typeof fetch | undefined,
    githubToken: opts.githubToken,
    probe: opts.probe,
    repoCoordinate: coordinate,
    repoSourceId: source.id,
    resolveCategory: async () => null,
  });
  const productId = entities.plan.products[0]?.productId ?? targetProduct?.id;
  const productWasDeclared =
    parseSelfDeclared(source.metadata)?.fields.includes("product") ?? false;
  const attach = Boolean(productId) && (source.productId === null || productWasDeclared);
  const plan: RepoReconcilePlan = {
    ...entities.plan,
    productBinding: { productId, matchBy, attach },
  };
  if (opts.dryRun) return { fetched: true, applied: false, plan };

  let attached = false;
  if (attach && productId) {
    const metadata = mergeSelfDeclaredMetadata(source.metadata, {
      fields: ["product"],
      source: "github",
      configHash: hash,
    });
    await db.update(sources).set({ productId, metadata }).where(eq(sources.id, source.id));
    attached = true;
  } else if (entities.plan.sources.length === 0) {
    const hasDeferredEntity = entities.plan.products.some((item) => item.action === "skip");
    const metadata = mergeSelfDeclaredMetadata(source.metadata, {
      fields: marker?.fields ?? [],
      source: "github",
      configHash: hasDeferredEntity ? `partial:${hash}` : hash,
    });
    await db.update(sources).set({ metadata }).where(eq(sources.id, source.id));
  }

  const applied = entities.applied || attached;
  logEvent("info", {
    component: "well-known",
    event: "repo-applied",
    sourceId,
    productId,
    applied,
  });
  return { fetched: true, applied, plan };
}
