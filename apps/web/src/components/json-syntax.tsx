import { Fragment, type ReactNode } from "react";

/**
 * Minimal JSON syntax highlighter for the terminal demo's "Agents" view.
 * Tokenizes an already-pretty-printed JSON string and colors string values,
 * numbers, and literals; keys and punctuation stay neutral (matching the
 * green-string terminal look). Pure string parsing — no dependency, and it
 * renders identically on server and client, so there's no hydration mismatch.
 *
 * Token roles:
 *   - key       a `"…"` immediately followed by `:` — left neutral
 *   - string    any other `"…"` (a value) — emerald
 *   - literal   `true` / `false` / `null` — amber
 *   - number    JSON numbers — amber
 *   - other     braces, commas, whitespace — neutral
 */
const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function JsonSyntax({ json }: { json: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of json.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      parts.push(<Fragment key={key++}>{json.slice(last, idx)}</Fragment>);
    }
    const full = m[0];
    const str = m[1];
    const colon = m[2];
    if (str !== undefined && colon !== undefined) {
      // object key (string + colon): keep neutral
      parts.push(<Fragment key={key++}>{full}</Fragment>);
    } else if (str !== undefined) {
      // string value
      parts.push(
        <span key={key++} className="text-emerald-600 dark:text-emerald-400">
          {full}
        </span>,
      );
    } else {
      // number / true / false / null
      parts.push(
        <span key={key++} className="text-amber-600 dark:text-amber-400">
          {full}
        </span>,
      );
    }
    last = idx + full.length;
  }
  if (last < json.length) {
    parts.push(<Fragment key={key++}>{json.slice(last)}</Fragment>);
  }
  return <>{parts}</>;
}
