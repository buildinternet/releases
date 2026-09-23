/**
 * Common request-payload sanitizers shared by routes that accept caller-
 * controlled strings (telemetry events, search-query log, etc.). Trims
 * whitespace, caps length, and treats the empty string as null.
 */
export function sanitizeString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

// Strip C0/C1 control chars (incl. ESC = 0x1b, which begins ANSI escape
// sequences) except tab (0x09) and newline (0x0a). Keeps stored caller text
// from injecting terminal escapes when an operator views it (CLI list, or a
// plain-text notification email opened in a terminal mail client). Char-code
// filter (not a control-char regex literal) keeps raw control bytes out of
// this source file.
function isControlChar(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false; // allow tab + newline
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isControlChar(ch.charCodeAt(0))) out += ch;
  }
  return out;
}

/**
 * sanitizeString + control-char stripping for any caller-supplied free-text or
 * header-sourced field that may be displayed to an operator. Trims, caps
 * length, strips control chars, and returns null for empty/non-string input.
 */
export function sanitizeText(v: unknown, max: number): string | null {
  const s = sanitizeString(v, max);
  if (s === null) return null;
  const cleaned = stripControl(s).trim();
  return cleaned.length > 0 ? cleaned : null;
}
