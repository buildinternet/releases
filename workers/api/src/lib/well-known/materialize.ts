import { and, eq, isNull } from "drizzle-orm";
import {
  blockedUrls,
  ignoredUrls,
  orgAccounts,
  products,
  sources,
} from "@buildinternet/releases-core/schema";
import { newProductId, newSourceId } from "@buildinternet/releases-core/id";
import { isValidKind } from "@buildinternet/releases-core/kinds";
import { toSlug } from "@buildinternet/releases-core/slug";
import type {
  ReleasesJsonDomain,
  ReleasesJsonDomainRelease,
  ReleasesJsonProduct,
  ReleasesJsonRepoRelease,
} from "@buildinternet/releases-api-types";
import { fetchAndParseFeed, type FeedType } from "@releases/adapters/feed";
import {
  parseAppStoreIdentifier,
  resolveAppStore,
  stripUoParam,
} from "@releases/adapters/appstore";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { buildAppStoreMeta } from "../appstore-materialize.js";
import { isPrivateOrLocalHost } from "../avatar-ingest.js";
import type { createDb } from "../../db.js";
import { configHash, mergeSelfDeclaredMetadata, parseSelfDeclared } from "./self-declared.js";

export type DeclaredLocation = ReleasesJsonDomainRelease | ReleasesJsonRepoRelease;
type Db = ReturnType<typeof createDb>;
type SourceType = "feed" | "github" | "appstore" | "scrape";

export interface ClassifiedLocation {
  type: SourceType;
  tier: 1 | 2;
  paused: boolean;
  locator: string;
}

export interface ExclusionPolicy {
  ignored: string[];
  blocked: Array<{ pattern: string; type: "exact" | "domain" }>;
}

export interface SourceMatchLike {
  id: string;
  type: string;
  url: string;
  slug: string;
  metadata: string | null;
  productId?: string | null;
  fetchPriority?: string | null;
}

export interface ProductMaterializationPlan {
  action: "match" | "create" | "skip";
  name: string;
  slug: string;
  productId?: string;
  matchBy?: "stable_id" | "locator" | "name";
  fills: string[];
  archived: boolean;
  note?: string;
}

export interface SourceMaterializationPlan {
  action: "match" | "create" | "skip";
  tier: 1 | 2;
  type: SourceType;
  locator: string;
  title: string;
  productId?: string;
  sourceId?: string;
  paused: boolean;
  canonical: boolean;
  note?: string;
}

export interface EntityMaterializationPlan {
  products: ProductMaterializationPlan[];
  sources: SourceMaterializationPlan[];
}

export interface ProbeResult {
  ok: boolean;
  note?: string;
  url?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface MaterializationOptions {
  dryRun: boolean;
  enabled: boolean;
  source: "well-known" | "github";
  fetchImpl?: typeof fetch;
  githubToken?: string;
  probe?: (location: DeclaredLocation, classified: ClassifiedLocation) => Promise<ProbeResult>;
  resolveCategory: (input: string) => Promise<string | null>;
  repoCoordinate?: string;
  repoSourceId?: string;
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return value;
  }
}

function githubCoordinateFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

function appStoreTrackId(value: string | undefined): string | null {
  return value ? (parseAppStoreIdentifier(value)?.trackId ?? null) : null;
}

export function classifyLocation(location: DeclaredLocation): ClassifiedLocation {
  if (location.feed) {
    return { type: "feed", tier: 1, paused: false, locator: location.feed };
  }
  if (location.github) {
    return {
      type: "github",
      tier: 1,
      paused: false,
      locator: location.github === "self" ? "self" : location.github,
    };
  }
  if (location.appstore) {
    return { type: "appstore", tier: 1, paused: false, locator: location.appstore };
  }
  if (location.file) {
    return { type: "scrape", tier: 2, paused: true, locator: location.file };
  }
  return { type: "scrape", tier: 2, paused: true, locator: location.url! };
}

export function locationMatchesSource(
  location: DeclaredLocation,
  source: SourceMatchLike,
): boolean {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(source.metadata ?? "{}") as Record<string, unknown>;
  } catch {
    // A malformed metadata blob cannot contribute a locator match.
  }
  const appStore = metadata.appStore as { trackId?: unknown } | undefined;
  const candidates = [
    location.url && normalizeUrl(location.url) === normalizeUrl(source.url),
    location.feed &&
      typeof metadata.feedUrl === "string" &&
      normalizeUrl(location.feed) === normalizeUrl(metadata.feedUrl),
    location.github &&
      location.github !== "self" &&
      (location.github.toLowerCase() === githubCoordinateFromUrl(source.url) ||
        location.github.toLowerCase() ===
          githubCoordinateFromUrl(
            typeof metadata.githubUrl === "string" ? metadata.githubUrl : undefined,
          )),
    location.appstore &&
      appStoreTrackId(location.appstore) !== null &&
      String(appStore?.trackId ?? "") === appStoreTrackId(location.appstore),
    location.file &&
      typeof metadata.declaredFileUrl === "string" &&
      normalizeUrl(location.file) === normalizeUrl(metadata.declaredFileUrl),
  ];
  return candidates.some(Boolean);
}

export function isUrlExcluded(url: string, policy: ExclusionPolicy): boolean {
  const normalized = normalizeUrl(url);
  if (policy.ignored.some((candidate) => normalizeUrl(candidate) === normalized)) return true;
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return policy.blocked.some((entry) =>
    entry.type === "exact"
      ? normalizeUrl(entry.pattern) === normalized
      : hostname === entry.pattern.toLowerCase() ||
        hostname.endsWith(`.${entry.pattern.toLowerCase()}`),
  );
}

function locationUrls(location: DeclaredLocation): string[] {
  return [location.url, location.feed, location.appstore, location.file].filter(
    (value): value is string => Boolean(value),
  );
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sourceTitle(
  location: DeclaredLocation,
  classified: ClassifiedLocation,
  productName?: string,
): string {
  if (location.title) return location.title;
  if (location.github && location.github !== "self") return location.github.split("/")[1]!;
  if (productName) return productName;
  try {
    return new URL(classified.locator).hostname;
  } catch {
    return classified.locator;
  }
}

function nextSlug(base: string, used: Set<string>): string {
  const normalized = toSlug(base) || "releases";
  for (let attempt = 1; attempt <= 20; attempt++) {
    const candidate = attempt === 1 ? normalized : `${normalized}-${attempt}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `${normalized}-${crypto.randomUUID().slice(0, 8)}`;
}

async function defaultProbe(
  location: DeclaredLocation,
  classified: ClassifiedLocation,
  opts: MaterializationOptions,
): Promise<ProbeResult> {
  if (classified.tier === 2) return { ok: true };
  if (classified.type === "feed") {
    let feedHost = "";
    try {
      feedHost = new URL(location.feed!).hostname;
    } catch {
      return { ok: false, note: "invalid_feed_url" };
    }
    if (isPrivateOrLocalHost(feedHost)) return { ok: false, note: "feed_private_host" };
    try {
      await fetchAndParseFeed(
        location.feed!,
        "unknown" as FeedType,
        { maxEntries: 1 },
        undefined,
        opts.fetchImpl,
      );
      return { ok: true, metadata: { feedUrl: location.feed } };
    } catch (error) {
      return {
        ok: false,
        note: `feed_probe_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (classified.type === "github") {
    const coordinate =
      location.github === "self" ? opts.repoCoordinate : (location.github as string | undefined);
    if (!coordinate) return { ok: false, note: "github_self_without_repo" };
    const [owner, repo] = coordinate.split("/");
    if (!owner || !repo) return { ok: false, note: "invalid_github_coordinate" };
    try {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": RELEASES_BOT_UA,
      };
      if (opts.githubToken) headers.authorization = `Bearer ${opts.githubToken}`;
      const response = await (opts.fetchImpl ?? fetch)(
        `https://api.github.com/repos/${owner}/${repo}`,
        { headers },
      );
      if (!response.ok) return { ok: false, note: `github_probe_failed:${response.status}` };
      const body = (await response.json()) as { name?: string };
      return {
        ok: true,
        url: `https://github.com/${coordinate}`,
        title: body.name ?? repo,
      };
    } catch (error) {
      return {
        ok: false,
        note: `github_probe_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const coordinate = parseAppStoreIdentifier(location.appstore!);
  if (!coordinate) return { ok: false, note: "invalid_appstore_locator" };
  const listing = await resolveAppStore(coordinate);
  if (!listing) return { ok: false, note: "appstore_probe_failed" };
  return {
    ok: true,
    url: stripUoParam(listing.trackViewUrl),
    title: listing.trackName,
    metadata: parseMetadata(buildAppStoreMeta(listing, coordinate)),
  };
}

function knownGitHubOwners(
  manifest: ReleasesJsonDomain,
  accounts: Array<{ handle: string }>,
  existingSources: SourceMatchLike[],
): Set<string> {
  const owners = new Set<string>();
  const declared = manifest.social?.github;
  if (declared) {
    const coordinate = githubCoordinateFromUrl(declared);
    owners.add((coordinate?.split("/")[0] ?? declared.replace(/^@/, "")).toLowerCase());
  }
  for (const account of accounts) owners.add(account.handle.replace(/^@/, "").toLowerCase());
  for (const source of existingSources) {
    const coordinate = githubCoordinateFromUrl(source.url);
    if (coordinate) owners.add(coordinate.split("/")[0]!);
  }
  return owners;
}

function productDeclaredData(product: ReleasesJsonProduct): Record<string, unknown> {
  return {
    ...(product.docs !== undefined ? { docs: product.docs } : {}),
    ...(product.support !== undefined ? { support: product.support } : {}),
    ...(product.social !== undefined ? { social: product.social } : {}),
    ...(product.archived !== undefined ? { archived: product.archived } : {}),
  };
}

function productWritable(metadata: string | null, field: string, empty: boolean): boolean {
  return empty || (parseSelfDeclared(metadata)?.fields.includes(field) ?? false);
}

async function applyProductFills(
  db: Db,
  row: typeof products.$inferSelect,
  declaration: ReleasesJsonProduct,
  category: string | null,
  hash: string,
  source: "well-known" | "github",
): Promise<string[]> {
  const fills: Record<string, unknown> = {};
  const fields: string[] = [];
  const add = (field: string, value: unknown, empty: boolean) => {
    if (value !== undefined && value !== null && productWritable(row.metadata, field, empty)) {
      fills[field] = value;
      fields.push(field);
    }
  };
  add("description", declaration.description, !row.description);
  add("url", declaration.website, !row.url);
  add("category", category, !row.category);
  add(
    "kind",
    declaration.kind && isValidKind(declaration.kind) ? declaration.kind : null,
    !row.kind,
  );

  const declared = productDeclaredData(declaration);
  const declaredFields = Object.keys(declared);
  if (declaredFields.length > 0) fields.push(...declaredFields);
  const metadata = mergeSelfDeclaredMetadata(row.metadata, {
    fields,
    source,
    configHash: hash,
    declared,
  });
  await db
    .update(products)
    .set({ ...fills, metadata })
    .where(eq(products.id, row.id));
  return fields;
}

async function materializeLocation(
  db: Db,
  location: DeclaredLocation,
  context: {
    orgId: string;
    productId: string | null;
    productName?: string;
    archived: boolean;
    existingSources: Array<typeof sources.$inferSelect>;
    policy: ExclusionPolicy;
    usedSourceSlugs: Set<string>;
    claimedLocators: Set<string>;
    githubOwners: Set<string>;
    hash: string;
  },
  opts: MaterializationOptions,
): Promise<{ plan: SourceMaterializationPlan; applied: boolean }> {
  const classified = classifyLocation(location);
  const title = sourceTitle(location, classified, context.productName);
  const existing =
    location.github === "self" && opts.repoSourceId
      ? context.existingSources.find((source) => source.id === opts.repoSourceId)
      : context.existingSources.find((source) => locationMatchesSource(location, source));
  if (existing) {
    const current = parseMetadata(existing.metadata);
    const currentDeclared =
      typeof current.declared === "object" && current.declared !== null
        ? (current.declared as Record<string, unknown>)
        : {};
    const metadata = mergeSelfDeclaredMetadata(existing.metadata, {
      fields: [
        "declared",
        ...(location.canonical ? ["canonical"] : []),
        ...(context.productId && !existing.productId ? ["product"] : []),
      ],
      source: opts.source,
      configHash: context.hash,
      declared: {
        ...currentDeclared,
        ...(location.canonical ? { canonical: true } : {}),
      },
    });
    if (!opts.dryRun) {
      await db
        .update(sources)
        .set({
          metadata,
          ...(context.productId && !existing.productId ? { productId: context.productId } : {}),
        })
        .where(eq(sources.id, existing.id));
    }
    return {
      plan: {
        action: "match",
        tier: classified.tier,
        type: classified.type,
        locator: classified.locator,
        title,
        productId: context.productId ?? undefined,
        sourceId: existing.id,
        paused: existing.fetchPriority === "paused",
        canonical: location.canonical === true,
      },
      applied: !opts.dryRun,
    };
  }

  const excluded = locationUrls(location).find((url) => isUrlExcluded(url, context.policy));
  if (excluded) {
    return {
      plan: {
        action: "skip",
        tier: classified.tier,
        type: classified.type,
        locator: classified.locator,
        title,
        productId: context.productId ?? undefined,
        paused: classified.paused,
        canonical: location.canonical === true,
        note: `excluded:${excluded}`,
      },
      applied: false,
    };
  }
  if (!opts.enabled) {
    return {
      plan: {
        action: "skip",
        tier: classified.tier,
        type: classified.type,
        locator: classified.locator,
        title,
        productId: context.productId ?? undefined,
        paused: classified.paused,
        canonical: location.canonical === true,
        note: "materialization_disabled",
      },
      applied: false,
    };
  }
  if (context.productName && !context.productId) {
    return {
      plan: {
        action: "skip",
        tier: classified.tier,
        type: classified.type,
        locator: classified.locator,
        title,
        paused: classified.paused,
        canonical: location.canonical === true,
        note: "product_unavailable",
      },
      applied: false,
    };
  }
  const locatorKey = `${classified.type}:${normalizeUrl(classified.locator)}`;
  if (context.claimedLocators.has(locatorKey)) {
    return {
      plan: {
        action: "skip",
        tier: classified.tier,
        type: classified.type,
        locator: classified.locator,
        title,
        productId: context.productId ?? undefined,
        paused: classified.paused,
        canonical: location.canonical === true,
        note: "duplicate_location",
      },
      applied: false,
    };
  }

  let effective = classified;
  if (location.github && location.github !== "self") {
    const owner = location.github.split("/")[0]!.toLowerCase();
    if (!context.githubOwners.has(owner)) effective = { ...classified, tier: 2, paused: true };
  }
  const probe = await (opts.probe ?? ((loc, kind) => defaultProbe(loc, kind, opts)))(
    location,
    effective,
  );
  if (!probe.ok) {
    return {
      plan: {
        action: "skip",
        tier: effective.tier,
        type: effective.type,
        locator: effective.locator,
        title,
        productId: context.productId ?? undefined,
        paused: effective.paused,
        canonical: location.canonical === true,
        note: probe.note ?? "probe_failed",
      },
      applied: false,
    };
  }

  const sourceId = newSourceId();
  const url =
    probe.url ??
    location.url ??
    (location.github && location.github !== "self"
      ? `https://github.com/${location.github}`
      : (location.feed ?? location.appstore ?? location.file))!;
  const routing = {
    ...probe.metadata,
    ...(location.feed ? { feedUrl: location.feed } : {}),
    ...(location.file ? { declaredFileUrl: location.file } : {}),
    declaredMaterialized: true,
    ...(location.canonical ? { canonical: true } : {}),
  };
  const metadata = mergeSelfDeclaredMetadata(JSON.stringify(routing), {
    fields: ["declared", ...(location.canonical ? ["canonical"] : [])],
    source: opts.source,
    configHash: context.hash,
    declared: routing,
  });
  const paused = effective.paused || context.archived;
  context.claimedLocators.add(locatorKey);
  if (!opts.dryRun) {
    await db.insert(sources).values({
      id: sourceId,
      orgId: context.orgId,
      productId: context.productId,
      name: probe.title ?? title,
      slug: nextSlug(probe.title ?? title, context.usedSourceSlugs),
      type: effective.type,
      url,
      metadata,
      fetchPriority: paused ? "paused" : "normal",
      discovery: "curated",
      isHidden: false,
    });
  }
  return {
    plan: {
      action: "create",
      tier: effective.tier,
      type: effective.type,
      locator: effective.locator,
      title: probe.title ?? title,
      productId: context.productId ?? undefined,
      sourceId: opts.dryRun ? undefined : sourceId,
      paused,
      canonical: location.canonical === true,
      ...(location.file ? { note: "document_parse_deferred" } : {}),
    },
    applied: !opts.dryRun,
  };
}

export async function reconcileDomainEntities(
  db: Db,
  orgId: string,
  manifest: ReleasesJsonDomain,
  opts: MaterializationOptions,
): Promise<{ plan: EntityMaterializationPlan; applied: boolean }> {
  const [existingProducts, existingSources, githubAccounts, ignored, blocked] = await Promise.all([
    db
      .select()
      .from(products)
      .where(and(eq(products.orgId, orgId), isNull(products.deletedAt))),
    db
      .select()
      .from(sources)
      .where(and(eq(sources.orgId, orgId), isNull(sources.deletedAt))),
    db
      .select({ handle: orgAccounts.handle })
      .from(orgAccounts)
      .where(and(eq(orgAccounts.orgId, orgId), eq(orgAccounts.platform, "github"))),
    db.select({ url: ignoredUrls.url }).from(ignoredUrls).where(eq(ignoredUrls.orgId, orgId)),
    db.select({ pattern: blockedUrls.pattern, type: blockedUrls.type }).from(blockedUrls),
  ]);
  const plan: EntityMaterializationPlan = { products: [], sources: [] };
  const policy: ExclusionPolicy = {
    ignored: ignored.map((row) => row.url),
    blocked,
  };
  const githubOwners = knownGitHubOwners(manifest, githubAccounts, existingSources);
  const usedProductSlugs = new Set(existingProducts.map((row) => row.slug));
  const usedSourceSlugs = new Set(existingSources.map((row) => row.slug));
  const claimedLocators = new Set<string>();
  const hash = configHash(manifest);
  let applied = false;
  const stableProductId =
    manifest.products?.length === 1 ? manifest.registries?.["releases.sh"]?.product : undefined;

  for (const declaration of manifest.products ?? []) {
    const locatorSource = declaration.releases
      ?.map((location) => existingSources.find((source) => locationMatchesSource(location, source)))
      .find((source) => source?.productId);
    const existing =
      (stableProductId
        ? existingProducts.find((product) => product.id === stableProductId)
        : undefined) ??
      (locatorSource
        ? existingProducts.find((product) => product.id === locatorSource.productId)
        : undefined) ??
      existingProducts.find((product) => product.name === declaration.name);
    const matchBy =
      stableProductId && existing?.id === stableProductId
        ? "stable_id"
        : locatorSource && existing?.id === locatorSource.productId
          ? "locator"
          : existing
            ? "name"
            : undefined;
    const category = declaration.category ? await opts.resolveCategory(declaration.category) : null;
    let productId: string | null = existing?.id ?? null;
    let productSlug = existing?.slug ?? toSlug(declaration.slug ?? declaration.name);
    let fills: string[] = [];
    let action: ProductMaterializationPlan["action"] = existing ? "match" : "create";
    let note: string | undefined;

    if (existing) {
      if (!opts.dryRun) {
        fills = await applyProductFills(db, existing, declaration, category, hash, opts.source);
        applied = true;
      }
    } else if (!opts.enabled) {
      action = "skip";
      note = "materialization_disabled";
      productId = null;
    } else {
      productSlug = nextSlug(declaration.slug ?? declaration.name, usedProductSlugs);
      if (!opts.dryRun) {
        productId = newProductId();
        const fields = [
          "declared",
          ...(declaration.description ? ["description"] : []),
          ...(declaration.website ? ["url"] : []),
          ...(category ? ["category"] : []),
          ...(declaration.kind && isValidKind(declaration.kind) ? ["kind"] : []),
          ...Object.keys(productDeclaredData(declaration)),
        ];
        await db.insert(products).values({
          id: productId,
          orgId,
          name: declaration.name,
          slug: productSlug,
          description: declaration.description ?? null,
          url: declaration.website ?? null,
          category,
          kind: declaration.kind && isValidKind(declaration.kind) ? declaration.kind : null,
          metadata: mergeSelfDeclaredMetadata("{}", {
            fields,
            source: opts.source,
            configHash: hash,
            declared: {
              materialized: true,
              ...productDeclaredData(declaration),
            },
          }),
        });
        applied = true;
      } else {
        productId = `planned:${productSlug}`;
      }
    }

    plan.products.push({
      action,
      name: declaration.name,
      slug: productSlug,
      productId: productId ?? undefined,
      matchBy,
      fills,
      archived: declaration.archived === true,
      note,
    });

    for (const location of declaration.releases ?? []) {
      const result = await materializeLocation(
        db,
        location,
        {
          orgId,
          productId,
          productName: declaration.name,
          archived: declaration.archived === true,
          existingSources,
          policy,
          usedSourceSlugs,
          claimedLocators,
          githubOwners,
          hash,
        },
        opts,
      );
      plan.sources.push(result.plan);
      applied ||= result.applied;
    }
  }

  for (const location of manifest.releases ?? []) {
    const result = await materializeLocation(
      db,
      location,
      {
        orgId,
        productId: null,
        archived: false,
        existingSources,
        policy,
        usedSourceSlugs,
        claimedLocators,
        githubOwners,
        hash,
      },
      opts,
    );
    plan.sources.push(result.plan);
    applied ||= result.applied;
  }
  return { plan, applied };
}
