/**
 * JSON.stringify by itself does not escape </script>, U+2028, or U+2029,
 * so embedding the result inside a <script type="application/ld+json"> tag
 * is unsafe when any field can contain attacker-controlled text. This
 * helper escapes the small set of characters that matter inside an HTML
 * script element.
 */
export function safeStringifyJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\u003c")
    .replace(/>/g, "\u003e")
    .replace(/&/g, "\u0026")
    .replace(/\u2028/gu, "\u2028")
    .replace(/\u2029/gu, "\u2029");
}
