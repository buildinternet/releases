/**
 * On-demand ISR opt-in for dynamic-segment routes.
 *
 * In the App Router a dynamic route (`/[orgSlug]`, `/sources/[id]`, …) is
 * rendered fresh on *every* request unless it exports `generateStaticParams` —
 * removing dynamic APIs (cookies/searchParams) is necessary but NOT sufficient
 * to make it cacheable. Returning an empty array prerenders nothing at build
 * time (so builds stay fast and we don't have to enumerate every org/source),
 * but with `dynamicParams` defaulting to `true` each path is rendered once on
 * first request and then served from the Full Route Cache, revalidated on the
 * route's `revalidate` window. This is what turns the org/product/source pages
 * from per-request dynamic into ISR. (#1607)
 *
 * Use as: `export const generateStaticParams = enableOnDemandIsr;`
 */
export function enableOnDemandIsr(): [] {
  return [];
}
