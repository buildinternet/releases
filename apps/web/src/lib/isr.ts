/**
 * ISR revalidate windows, in seconds.
 *
 * Kept in a dependency-free module so the guard test (`isr.test.ts`) and any
 * runtime caller can share the numbers without dragging in `lib/api`'s fetch
 * surface.
 */

/**
 * Default Data Cache / ISR revalidate window for API reads, and the window the
 * ISR pages themselves declare.
 *
 * Content freshness does NOT ride on this clock: the API worker pings
 * `POST /api/revalidate` on ingest, so an org/source/product page regenerates
 * when a release actually lands. This is the backstop for when that ping is
 * dropped — bounded staleness, not the primary mechanism.
 */
export const DEFAULT_REVALIDATE_SECONDS = 86_400;

/**
 * Floor for any fetch-level `next: { revalidate }` reachable from the ROOT
 * LAYOUT.
 *
 * A statically-rendered route's regeneration period is the MIN of its
 * `export const revalidate` and every fetch revalidate in its render tree.
 * A fetch in the layout is on every route, so a low value there silently
 * overrides all of them — invisible at runtime, visible only as a Vercel ISR
 * write bill. Enforced by `isr.test.ts`.
 *
 * Fetches outside the layout tree are unconstrained: a route handler caching
 * its own upstream for an hour only affects its own route.
 *
 * MUST stay an independent literal — do NOT define it as
 * `DEFAULT_REVALIDATE_SECONDS`. The likeliest future regression is someone
 * "tuning" that default down; if the floor is an alias of it, the floor moves
 * too and the guard reports green while the whole site re-caps at the new
 * value. `isr.test.ts` asserts the default sits at or above this
 * independently, which is what catches a lowered default propagating through
 * `applyCacheInit` — indirection the source scan cannot see.
 */
export const ISR_REVALIDATE_FLOOR_SECONDS = 86_400;
