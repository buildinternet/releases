/**
 * cx — merge a base class string with an optional caller-supplied `className`.
 *
 * Internal helper (deliberately NOT part of the public surface in `index.ts`):
 * every wrapper component appends its passthrough `className` after the base
 * class so callers can extend without overriding. Kept dependency-free (no
 * `clsx`) on purpose — if richer merging is ever needed, this is the one place
 * to add it.
 */
export function cx(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}
