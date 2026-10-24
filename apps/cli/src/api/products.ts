import type { Product } from "@buildinternet/releases-core/schema";
import type { Kind } from "@buildinternet/releases-core/kinds";
import type { ProductDetail } from "@buildinternet/releases-api-types";
import type { ProductRef } from "@buildinternet/releases-sdk";
import { apiFetch } from "./core.js";
import { find } from "./sdk.js";
import { assertCleanIdentifier } from "../lib/validate-input.js";
import { computePagination, type ListResponse } from "@buildinternet/releases-core/cli-contracts";

// ── Product queries ──

export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string; category?: string; kind?: Kind },
): Promise<Product> {
  return apiFetch<Product>(`/v1/products`, {
    method: "POST",
    body: JSON.stringify({
      orgId,
      name,
      slug: opts?.slug,
      url: opts?.url,
      description: opts?.description,
      category: opts?.category,
      kind: opts?.kind,
    }),
  });
}

/** Sibling of `resolveSourceTarget` for products. Same identifier shapes. */
async function resolveProductRef(identifier: string): Promise<ProductRef | null> {
  assertCleanIdentifier(identifier, "product");
  if (identifier.startsWith("prod_")) return identifier;
  const slash = identifier.indexOf("/");
  if (slash > 0 && slash < identifier.length - 1) {
    return { org: identifier.slice(0, slash), product: identifier.slice(slash + 1) };
  }
  const resolved = await find((c) =>
    c.request<{ productId: string; productSlug: string; orgSlug: string }>(
      "GET /lookups/product-by-slug",
      { query: { slug: identifier } },
    ),
  );
  return resolved ? { org: resolved.orgSlug, product: resolved.productSlug } : null;
}

export async function findProduct(identifier: string): Promise<ProductDetail | null> {
  const ref = await resolveProductRef(identifier);
  if (!ref) return null;
  return find((c) => c.products.get(ref));
}

export type ProductWithSourceCount = Product & { sourceCount: number };

/**
 * List products via `GET /v1/products`. Omit `orgId` to enumerate products
 * across every org — the org-agnostic form backing `releases admin product
 * list` with no org argument (releases-cli#259). Returns the paginated
 * envelope so callers can surface `pagination.hasMore`; `getProductsByOrg`
 * unwraps it for the single-org callers that only want the rows.
 *
 * `/v1/products` returns a paginated envelope; the legacy bare-array shape is
 * tolerated too in case an old worker is ever in the path. Without the unwrap,
 * downstream `for/find/filter/map` would silently iterate an object and yield
 * nothing — which is what made `releases org get` skip the Products section.
 */
export async function listProducts(opts?: {
  orgId?: string;
  kind?: Kind;
  limit?: number;
  page?: number;
}): Promise<ListResponse<ProductWithSourceCount>> {
  const params = new URLSearchParams();
  if (opts?.orgId) params.set("orgId", opts.orgId);
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  const qs = params.toString();
  const raw = await apiFetch<ProductWithSourceCount[] | ListResponse<ProductWithSourceCount>>(
    `/v1/products${qs ? `?${qs}` : ""}`,
  );
  if (!raw) {
    return {
      items: [],
      pagination: computePagination({
        page: opts?.page ?? 1,
        pageSize: opts?.limit ?? 0,
        returned: 0,
        totalItems: 0,
      }),
    };
  }
  if (Array.isArray(raw)) {
    return {
      items: raw,
      pagination: computePagination({
        page: 1,
        pageSize: raw.length,
        returned: raw.length,
        totalItems: raw.length,
      }),
    };
  }
  return raw;
}

export async function getProductsByOrg(
  orgId: string,
  opts?: { kind?: Kind },
): Promise<ProductWithSourceCount[]> {
  const { items } = await listProducts({ orgId, kind: opts?.kind });
  return items;
}

export async function updateProduct(
  product: Pick<Product, "id">,
  data: Record<string, unknown>,
): Promise<Product> {
  return apiFetch<Product>(`/v1/products/${encodeURIComponent(product.id)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteProduct(productId: string): Promise<void> {
  await apiFetch(`/v1/products/${productId}`, { method: "DELETE" });
}

// ── Tags for products ──

export async function getTagsForProduct(productId: string): Promise<string[]> {
  return apiFetch<string[]>(`/v1/products/${productId}/tags`);
}

export async function addTagsToProduct(productId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/products/${productId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function removeTagsFromProduct(productId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/products/${productId}/tags`, {
    method: "DELETE",
    body: JSON.stringify({ tags: tagNames }),
  });
}
