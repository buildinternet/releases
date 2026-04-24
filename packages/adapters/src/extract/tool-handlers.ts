import { JSONPath } from "jsonpath-plus";

export const MAX_TOOL_RESULT_CHARS = 20_000;

export interface GetSliceInput {
  start: number;
  length: number;
}

export function handleGetSlice(body: string, input: GetSliceInput): string {
  const start = Math.max(0, Math.min(Math.floor(input.start), body.length));
  const length = Math.max(0, Math.min(Math.floor(input.length), MAX_TOOL_RESULT_CHARS));
  return body.slice(start, start + length);
}

export interface QueryJsonInput {
  path: string;
}

export function handleQueryJson(body: string, input: QueryJsonInput): string {
  // Validate that the path starts with $ — jsonpath-plus is permissive and returns []
  // for malformed paths; we want to surface the error clearly instead.
  if (!input.path.startsWith("$")) {
    throw new Error(`invalid JSONPath: path must start with "$" (got: ${input.path})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // partial-json is intentionally not used here — the body was already found to be
    // parseable-or-partial in the preview. If the full body isn't valid JSON at query
    // time, the caller shouldn't have offered query_json.
    throw new Error("body is not valid JSON");
  }

  const result = JSONPath({ path: input.path, json: parsed as object });

  if (result.length === 0) {
    return `no matches for ${input.path}`;
  }

  // Reserve space for "[", "]", and a worst-case elision suffix so the final
  // return is guaranteed not to exceed MAX_TOOL_RESULT_CHARS.
  const maxDigits = String(result.length).length;
  const worstSuffix = ` ... ${"9".repeat(maxDigits)} more items elided (total ${"9".repeat(maxDigits)})`;
  const cap = MAX_TOOL_RESULT_CHARS - 2 - worstSuffix.length;

  const serialized: string[] = [];
  let contentLen = 0;

  for (const item of result) {
    const next = JSON.stringify(item);
    const sep = serialized.length === 0 ? 0 : 1;
    if (contentLen + sep + next.length > cap) break;
    serialized.push(next);
    contentLen += sep + next.length;
  }

  if (serialized.length === result.length) {
    return result.length === 1 ? serialized[0]! : `[${serialized.join(",")}]`;
  }

  const elided = result.length - serialized.length;
  return `[${serialized.join(",")}] ... ${elided} more items elided (total ${result.length})`;
}
