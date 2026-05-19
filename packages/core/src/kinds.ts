export const KIND_VALUES = [
  "platform",
  "sdk",
  "mobile",
  "desktop",
  "docs",
  "integration",
  "tool",
] as const;

export type Kind = (typeof KIND_VALUES)[number];

export function isValidKind(value: string): value is Kind {
  return (KIND_VALUES as readonly string[]).includes(value);
}

type WithMaybeKind = { kind?: Kind | null | undefined };

/**
 * Resolve a source's effective kind. Returns the source's own `kind` if set,
 * otherwise the parent product's `kind` if a product is provided and set,
 * otherwise `null`. Null means "no opinion" — callers should treat unset rows
 * as default-weighted, not silently coerce to a specific value.
 */
export function resolveSourceKind(
  source: WithMaybeKind,
  product: WithMaybeKind | null | undefined,
): Kind | null {
  if (source.kind) return source.kind;
  if (product && product.kind) return product.kind;
  return null;
}
