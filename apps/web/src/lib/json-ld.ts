/**
 * JSON.stringify by itself does not escape </script>, U+2028, or U+2029,
 * so embedding the result inside a <script type="application/ld+json"> tag
 * is unsafe when any field can contain attacker-controlled text. This
 * helper emits backslash-u escape sequences (literal "<" etc., not
 * the decoded characters) so the raw HTML the browser sees can never
 * close the surrounding script tag; JSON.parse decodes them back at
 * consumption time.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function safeStringifyJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}
