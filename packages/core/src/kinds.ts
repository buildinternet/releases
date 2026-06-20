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

/**
 * Parse a raw `?kind=` query-string value.
 * - `undefined` (param absent) → `undefined`
 * - valid enum member → `Kind`
 * - any other string → `null` (caller should return 400)
 */
export function parseKindParam(raw: string | undefined): Kind | undefined | null {
  if (raw === undefined) return undefined;
  if (isValidKind(raw)) return raw;
  return null;
}

/**
 * Source kinds whose releases carry developer-facing upgrade semantics — "can I
 * take this safely, and what do I migrate?" — and therefore qualify for
 * breaking-change classification at ingest (#1696). Libraries/SDKs (`sdk`),
 * dev tools/CLIs (`tool`), service/API platforms (`platform`), and plugins/
 * integrations (`integration`) all expose a contract a consumer's code depends
 * on, so a release can break that contract.
 *
 * Deliberately EXCLUDED: `mobile` (consumer App Store apps — users don't migrate
 * code), `docs` (documentation sites), `desktop` (mixed consumer/dev surface;
 * conservative omission, revisit if dev-tool desktop apps want it), and
 * kind-less rows (no opinion). Excluded rows stay `breaking: "unknown"` and
 * never spend a classifier call — precision-first, fail-open. This is the
 * "which releases qualify" policy gate; widen the set here if the editorial
 * scope changes.
 */
export const BREAKING_CLASSIFY_KINDS = ["sdk", "tool", "platform", "integration"] as const;

/**
 * True when a resolved kind (see {@link resolveSourceKind}) is one whose
 * releases should be run through breaking-change classification. `null` (no
 * resolved kind) returns false — fail-open to `unknown`.
 */
export function qualifiesForBreakingClassification(kind: Kind | null): boolean {
  return kind !== null && (BREAKING_CLASSIFY_KINDS as readonly string[]).includes(kind);
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
