import { resolveSourceKind, type Kind } from "@buildinternet/releases-core/kinds";

/** Minimum resolved-SDK sources before they fold into a collapsible group. */
export const SDK_GROUP_MIN = 2;

type KindBearer = { kind?: Kind | null };

/**
 * Split an org's sources into the SDK family vs. everything else.
 *
 * A source is "SDK" when its resolved kind — its own `kind`, else the parent
 * product's `kind` (via `resolveSourceKind`) — is `"sdk"`. Below
 * `SDK_GROUP_MIN` resolved SDKs, returns everything in `flat` with an empty
 * `sdk` so the caller renders no group.
 */
export function partitionSdkSources<S extends KindBearer & { productSlug?: string | null }>(
  sources: readonly S[],
  products: readonly ({ slug: string } & KindBearer)[],
): { flat: S[]; sdk: S[] } {
  const productBySlug = new Map(products.map((p) => [p.slug, p]));
  const sdk: S[] = [];
  const flat: S[] = [];
  for (const source of sources) {
    const product = source.productSlug ? (productBySlug.get(source.productSlug) ?? null) : null;
    if (resolveSourceKind(source, product) === "sdk") sdk.push(source);
    else flat.push(source);
  }
  if (sdk.length < SDK_GROUP_MIN) return { flat: [...sources], sdk: [] };
  return { flat, sdk };
}

/** Member preview for the collapsed SDK header — names joined by " · ", busiest first. */
export function sdkPreview(sdk: readonly { name: string; releaseCount: number }[]): string {
  return [...sdk]
    .sort((a, b) => b.releaseCount - a.releaseCount)
    .map((member) => member.name)
    .join(" · ");
}
