import chalk from "chalk";
import { IMPORTANCE_MAX, IMPORTANCE_MIN } from "@buildinternet/releases-core/importance";
import { isDateKey } from "@buildinternet/releases-core/dates";

/**
 * Parse a positive-integer CLI flag value. Returns `undefined` if the option
 * was not provided. Exits with code 2 (usage error) on invalid input — matches
 * commander's own conventions for argument errors.
 */
export function parsePositiveIntFlag(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // Strict integer match first — Number.parseInt would silently accept "1.5" → 1
  // and "10abc" → 10. Allow an optional leading minus so the range check below
  // produces the same error message for "-1" as it does for "1.5".
  const isInt = /^-?\d+$/.test(raw);
  const n = isInt ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    console.error(chalk.red(`Invalid --${label}: must be a positive integer (got ${raw})`));
    process.exit(2);
  }
  return n;
}

/** Bare-flag default for `--max-content-chars` — matches the per-release clip
 * the `regenerating-overviews` generation step applies anyway, so nothing
 * useful is lost for the overview use case. */
export const MAX_CONTENT_CHARS_DEFAULT = 1000;

/**
 * Resolve the `--max-content-chars [n]` option for `overview inputs --json`.
 * Commander hands us `undefined` when the flag is omitted, the boolean `true`
 * when it's passed bare (→ {@link MAX_CONTENT_CHARS_DEFAULT}), or the raw string
 * when given a value (→ parsed as a positive integer, exiting 2 on bad input).
 * `false` can't occur for an optional-value option but is handled as omitted.
 */
export function parseMaxContentCharsFlag(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return MAX_CONTENT_CHARS_DEFAULT;
  return parsePositiveIntFlag("max-content-chars", raw);
}

/**
 * Parse a non-negative-integer CLI flag value (0 is allowed). Returns
 * `undefined` if the option was not provided. Exits with code 2 on invalid
 * input.
 */
export function parseNonNegIntFlag(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // Strict integer match first — Number.parseInt would silently accept "1.5" → 1
  // and "10abc" → 10. Allow an optional leading minus so the range check below
  // produces the same error message for "-1" as it does for "1.5".
  const isInt = /^-?\d+$/.test(raw);
  const n = isInt ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    console.error(chalk.red(`Invalid --${label}: must be a non-negative integer (got ${raw})`));
    process.exit(2);
  }
  return n;
}

/** Relative time-window shorthand accepted by the API: `<n><unit>` (d/w/m/y). */
const TIME_WINDOW_RELATIVE_RE = /^(\d+)([dwmy])$/i;
/**
 * ISO accepted by the API's resolver: a date or a timezone-qualified datetime.
 * Kept in lockstep with `ISO_DATE_RE` in @buildinternet/releases-core/dates so
 * the CLI rejects the same shapes the server would (bare numbers, `2026/01/01`,
 * and tz-less datetimes, which the server parses ambiguously as local time).
 */
const TIME_WINDOW_ISO_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?))?$/;

/**
 * Validate a `--since`/`--until` flag value. The API resolves relative
 * shorthand server-side, so the CLI only fast-fails on obviously-malformed
 * input and forwards the trimmed value verbatim as a query param. Accepts an
 * ISO date (`2026-01-01`), a timezone-qualified datetime (`…Z` / `…+05:00`),
 * or relative shorthand (`90d`, `4w`, `6m`, `2y`). Returns `undefined` when the
 * flag was omitted; exits with code 2 on a malformed value (matches the other
 * flag parsers here). A bare number, `2026/01/01`, a tz-less datetime, and an
 * impossible bare date (`2026-02-30`) are rejected so the local check matches
 * the server contract.
 */
export function parseTimeWindowFlag(label: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // A bare date must also be a real calendar day: `new Date` rolls overflow
  // forward (`2026-02-30` → Mar 2) instead of failing, and the server rejects
  // it with a 400 (core `resolveDateParam`), so fail fast here with exit 2.
  const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const valid =
    TIME_WINDOW_RELATIVE_RE.test(trimmed) ||
    (TIME_WINDOW_ISO_RE.test(trimmed) &&
      !Number.isNaN(new Date(trimmed).getTime()) &&
      (!isBareDate || isDateKey(trimmed)));
  if (!valid) {
    console.error(
      chalk.red(
        `Invalid --${label}: "${raw}" — must be an ISO date (e.g. 2026-01-01) or relative shorthand (90d, 4w, 6m, 2y)`,
      ),
    );
    process.exit(2);
  }
  return trimmed;
}

/**
 * Validate the `--min-importance <1-5>` flag. The range mirrors the server's
 * `ImportanceScoreSchema` bounds (`IMPORTANCE_MIN`..`IMPORTANCE_MAX`, from
 * `@buildinternet/releases-core/importance` — the same constants the wire
 * schema validates against), so a bad value fails fast locally instead of
 * round-tripping to the API for its 400. Returns `undefined` when the flag
 * was omitted; exits with code 2 on a malformed value (matches the other flag
 * parsers here).
 *
 * Server semantics worth knowing: the filter compiles to `importance >= ?`,
 * which never matches a NULL column, so passing this flag drops every unscored
 * release. Only a recent window of history is scored, so even
 * `--min-importance 1` is far from a no-op.
 */
export function parseImportanceFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // Strict integer match first — Number.parseInt would silently accept "1.5" → 1
  // and "4abc" → 4.
  const isInt = /^-?\d+$/.test(raw);
  const n = isInt ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < IMPORTANCE_MIN || n > IMPORTANCE_MAX) {
    console.error(
      chalk.red(
        `Invalid --min-importance: must be an integer between ${IMPORTANCE_MIN} and ${IMPORTANCE_MAX} (got ${raw})`,
      ),
    );
    process.exit(2);
  }
  return n;
}

/** Parse a comma-separated `--tags foo,bar` flag into a trimmed, non-empty list. */
export function parseTagList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Parse a `--metadata-set key=value` token into a `[key, coercedValue]` pair.
 *
 * Value coercion rules (applied in order):
 *   - `true` / `false` / `null`   → JSON literal (boolean / null)
 *   - Finite number string         → number
 *   - Starts with `{` or `[`      → parsed as JSON (exits on invalid JSON)
 *   - Otherwise                    → string
 *
 * Key constraints:
 *   - Must contain `=` (first `=` splits key and value)
 *   - Key must not be empty
 *   - Key must not contain `.` or `[` (nested-path mutation is not supported)
 *
 * Exits with code 2 on any validation failure.
 */
export function parseMetadataSetFlag(raw: string): [string, unknown] {
  const eqIdx = raw.indexOf("=");
  if (eqIdx < 1) {
    console.error(
      chalk.red(
        `Invalid --metadata-set "${raw}": expected key=value (key must be non-empty and separated by "=")`,
      ),
    );
    process.exit(2);
  }
  const key = raw.slice(0, eqIdx);
  const value = raw.slice(eqIdx + 1);

  if (key.includes(".") || key.includes("[")) {
    console.error(
      chalk.red(
        `Invalid --metadata-set key "${key}": nested paths (keys containing "." or "[") are not supported. ` +
          `To mutate nested structure, pass the whole object: --metadata-set ${key}='{"...": "..."}'`,
      ),
    );
    process.exit(2);
  }

  return [key, coerceMetadataValue(value)];
}

/**
 * Coerce a raw CLI string value to the appropriate JSON type.
 * Called by `parseMetadataSetFlag`; also exported for unit-testing.
 */
export function coerceMetadataValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;

  // Number: must be finite; guard against the empty-string edge case.
  if (value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  // JSON object or array
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      console.error(
        chalk.red(`Invalid --metadata-set value: could not parse as JSON: ${value.slice(0, 80)}`),
      );
      process.exit(2);
    }
  }

  return value;
}
