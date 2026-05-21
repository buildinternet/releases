/**
 * Shared harness for driving the API worker's Hono sub-apps directly in unit
 * tests. Centralizes the no-op ExecutionContext and the `routes.request(...)`
 * boilerplate that had been hand-rolled in every tests/api/* file.
 */

/**
 * No-op ExecutionContext. Workers receive a real ctx (waitUntil /
 * passThroughOnException); tests don't need the deferred work to actually run,
 * so both are no-ops. It's cast to the route's expected ctx type at the call
 * boundary — Hono types `.request`'s 4th arg as the worker's ExecutionContext.
 */
export const noopExecutionCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

/**
 * The slice of a Hono app's `.request` these callers drive. Hono types the
 * return as `Response | Promise<Response>`; the helpers below normalize it to
 * a Promise so call sites can always `await`.
 */
type RouteApp = {
  request(path: string, init: RequestInit, env: never, ctx: never): Response | Promise<Response>;
};

/**
 * Build a `(path, init?) => Response` caller bound to a route. `getEnv` is a
 * thunk so the env (and its test DB) is read fresh on every call, tracking a
 * `beforeEach`-reassigned `TestDatabase` instead of capturing a stale handle.
 * Defaults to a GET when no init is supplied.
 */
export function makeCaller(routes: RouteApp, getEnv: () => unknown) {
  return (path: string, init: RequestInit = { method: "GET" }): Promise<Response> =>
    Promise.resolve(routes.request(path, init, getEnv() as never, noopExecutionCtx as never));
}

/**
 * Build a `(path, method, body?) => Response` caller. JSON-encodes `body` and
 * sets `content-type` only when a body is present, matching what the route
 * handlers expect from a real fetch.
 */
export function makeJsonCaller(routes: RouteApp, getEnv: () => unknown) {
  return (path: string, method: string, body?: unknown): Promise<Response> =>
    Promise.resolve(
      routes.request(
        path,
        {
          method,
          headers: body !== undefined ? { "content-type": "application/json" } : undefined,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        getEnv() as never,
        noopExecutionCtx as never,
      ),
    );
}
