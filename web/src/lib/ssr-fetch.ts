/**
 * Tri-state SSR fetch helper for supplementary data panels.
 *
 * Returns `{ data, error: null }` on success or `{ data: null, error }` on
 * failure. Failures are logged as structured JSON to stderr (visible in Vercel
 * function logs) but do not propagate — callers can render an inline error UI
 * while the rest of the page stays intact.
 *
 * Use this for supplementary panels (heatmaps, sparklines, tickers) where a
 * partial render is more useful than an error page. For primary feeds, remove
 * the `.catch(() => null)` and add an `error.tsx` segment boundary instead.
 */

export type SsrResult<T> = { data: T; error: null } | { data: null; error: Error };

export async function tryFetch<T>(
  promise: Promise<T>,
  ctx: { route: string; event: string },
): Promise<SsrResult<T>> {
  try {
    const data = await promise;
    return { data, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(
      JSON.stringify({
        component: "web-ssr",
        event: ctx.event,
        route: ctx.route,
        err: { message: error.message, stack: error.stack },
      }),
    );
    return { data: null, error };
  }
}
