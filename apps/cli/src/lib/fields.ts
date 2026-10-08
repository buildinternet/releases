/**
 * Generic field-projection mask for `--fields` on the reader commands.
 *
 * `--fields` post-filters a command's `--json` output down to a caller-supplied
 * set of keys, so an agent can pull exactly the leaves it needs and spend fewer
 * tokens. It composes with the slim/full choice: it projects whatever shape the
 * reader already produced (the slim shape by default, the full payload with
 * `--full`), reusing that documented vocabulary rather than inventing its own.
 *
 * Syntax: a comma-separated list, with dot-notation for nested keys
 * (`source.slug`, `org.name`). Dot-notation walks plain objects only — it does
 * not index into arrays, so request an array-valued field whole (`media`) and
 * read its elements client-side.
 *
 * A requested field that isn't present is simply absent from the output (no
 * throw); callers surface a single stderr warning for fields that matched
 * nothing, so a typo is visible without corrupting the JSON on stdout.
 */

import { logger } from "@buildinternet/releases-lib/logger";

/** Split + trim + dedupe a raw `--fields` value into an ordered path list. */
export function parseFieldsFlag(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const f = part.trim();
    if (f.length > 0 && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Project a single object down to `fields`, recording which paths resolved. */
function projectOne(obj: unknown, fields: string[], matched: Set<string>): unknown {
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const path = field.split(".");
    // Walk to the leaf; bail (skip the field) if any segment is missing or the
    // intermediate isn't a plain object (dot-notation doesn't index arrays).
    let cur: unknown = obj;
    let ok = true;
    for (const key of path) {
      if (isPlainObject(cur) && key in cur) cur = cur[key];
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    matched.add(field);
    // Re-create the nested structure in the output, merging leaves that share a
    // parent (`source.slug` + `source.name` → one `source` object).
    let dst = out;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      if (!isPlainObject(dst[key])) dst[key] = {};
      dst = dst[key] as Record<string, unknown>;
    }
    dst[path[path.length - 1]!] = cur;
  }
  return out;
}

export interface ProjectResult {
  projected: unknown;
  /** Fields that resolved against at least one input object. */
  matched: Set<string>;
}

/**
 * Project `data` (a single object or an array of objects) down to `fields`.
 * A scalar/null passes through untouched. The returned `matched` set lets the
 * caller warn about fields that resolved nowhere.
 */
export function projectFields(data: unknown, fields: string[]): ProjectResult {
  const matched = new Set<string>();
  if (Array.isArray(data)) {
    return { projected: data.map((item) => projectOne(item, fields, matched)), matched };
  }
  return { projected: projectOne(data, fields, matched), matched };
}

/** Fields the caller asked for that resolved against nothing. */
export function unmatchedFields(fields: string[], matched: Set<string>): string[] {
  return fields.filter((f) => !matched.has(f));
}

/**
 * Convenience for the single-object / single-array readers (`get`, `tail`): if
 * `rawFields` is set, project `value` and emit one stderr warning for any field
 * that matched nothing (so a typo is visible without corrupting stdout JSON).
 * Returns `value` unchanged when no mask was passed. Search composes the pure
 * pieces directly instead, since it projects several entity arrays at once.
 */
export function applyFieldMask(value: unknown, rawFields: string | undefined): unknown {
  if (rawFields === undefined) return value;
  const fields = parseFieldsFlag(rawFields);
  if (fields.length === 0) return value;
  const { projected, matched } = projectFields(value, fields);
  const missing = unmatchedFields(fields, matched);
  if (missing.length > 0) {
    logger.warn(
      `--fields: ignored unknown field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    );
  }
  return projected;
}
