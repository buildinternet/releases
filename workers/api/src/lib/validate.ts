/**
 * JSON body validator that wires `hono-openapi`'s `validator("json", ...)` to
 * the worker's `{ error: "bad_request", message }` envelope.
 *
 * Two payoffs over hand-rolled `await c.req.json().catch(...)` + ad-hoc checks
 * in each handler:
 *   1. The Zod schema is published in `requestBody.content["application/json"]`
 *      of the route's OpenAPI spec automatically — Phase 2 of issue #894.
 *   2. The handler reads `c.req.valid("json")` and is guaranteed a typed,
 *      parsed body. No second-pass validation; no `body as Record<…>` cast.
 *
 * The hook flattens Standard Schema issues to a single `message` string so the
 * envelope shape stays consistent with the existing prose-parsed routes (e.g.
 * `webhooks.ts`, `ignore.ts`). Path segments are joined with `.` — sufficient
 * for our flat-ish request shapes and human-readable in the error response.
 */
import { validator } from "hono-openapi";

type StandardIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};

function formatPath(path: StandardIssue["path"]): string {
  if (!path || path.length === 0) return "";
  return path
    .map((segment) => {
      if (segment !== null && typeof segment === "object" && "key" in segment) {
        return String(segment.key);
      }
      return String(segment);
    })
    .join(".");
}

/**
 * Flattens validation issues into a single semicolon-joined message. Echoes
 * the path so clients can pinpoint the bad field, e.g.
 * `"month: Number must be greater than or equal to 1"`.
 */
function formatIssues(issues: readonly StandardIssue[]): string {
  return issues
    .map((issue) => {
      const path = formatPath(issue.path);
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Wire a Zod (or any Standard Schema) body schema as Hono middleware.
 * On parse failure the response is `400 { error: "bad_request", message }`;
 * on success the handler can read the typed body via `c.req.valid("json")`.
 *
 * Malformed JSON (un-parseable bytes) is still raised as an `HTTPException`
 * by Hono's underlying validator — the global `onError` in `index.ts` maps
 * it to the same envelope.
 */
export function validateJson<S extends Parameters<typeof validator>[1]>(schema: S) {
  return validator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "bad_request",
          message: formatIssues(result.error as readonly StandardIssue[]),
        },
        400,
      );
    }
  });
}
