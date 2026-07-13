/**
 * Geist Pixel (Square variant) — inlined for the OG-image wordmark.
 *
 * Two problems shape this file:
 *
 * 1. Satori (the engine behind `next/og`) can't parse woff2, the only format the
 *    `geist` package ships for the pixel faces. So this is the woff2 decompressed
 *    to TTF, then subset to just the wordmark's glyphs ({ . a e h l r s }).
 *
 * 2. Satori treats the FIRST provided font as the global default for any text
 *    whose `fontFamily` doesn't match a loaded font — and `next/og` puts caller
 *    fonts first. A normally-encoded pixel font would therefore get picked as the
 *    fallback for every 'a'/'e'/'r'/'s'… across titles and metrics, producing a
 *    ransom-note mix. To make that impossible, every glyph here is remapped into
 *    the Private Use Area at codepoint (0xE000 + its ASCII value). Normal body
 *    text never contains U+E0xx, so this face can never match it; the wordmark
 *    opts in by shifting its own characters into that range via `pixelWordmark`.
 *
 * Base64-inlined (≈1.5 KB) so the OG routes load it synchronously at module scope
 * with no filesystem/network hop and stay runtime-agnostic (edge or node). OG
 * routes are server-only, so this never reaches the client bundle.
 *
 * To change the wordmark string, re-subset from the source font and re-apply the
 * PUA remap — see scripts note in the PR. SIL Open Font License (geist).
 */
const PIXEL_WORDMARK_TTF_BASE64 =
  "AAEAAAAOAIAAAwBgR0RFRgARAAcAAAT8AAAAFkdQT1Mr3CSJAAAFFAAAAJBHU1VCuPq49AAABaQAAAAqT1MvMlUSZCcAAAFoAAAAYGNtYXChoqFQAAAB6AAAAFxnYXNwAAAAEAAABPQAAAAIZ2x5Zly+IKMAAAJYAAACcmhlYWQ1nGIjAAAA7AAAADZoaGVhBk8FdQAAASQAAAAkaG10eA7+AcgAAAHIAAAAIGxvY2EDUwLNAAACRAAAABJtYXhwAAwANQAAAUgAAAAgbmFtZQAGAAAAAATMAAAABnBvc3T/nwAyAAAE1AAAACAAAQAAAAEAAFu6PvBfDzz1CA8D6AAAAADloCIcAAAAAOZ5/FIAJgAAAjoC0gAAAAYAAgAAAAAAAAABAAAD7f7ZAAAChgAmACYCOgPoAAAAAAAAAAAAAAAAAAAACAABAAAACAA0AAMAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAQCJwGQAAUAAAKKAlgAAABLAooCWAAAAV4AMgE/AAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAFZSQ0wAwAAuAHMD7f7ZAAAEQAGKAAAAAQAAAAACFALSAAAAIAADAoYATAI6AEwCFAAmAjoATAF8ACYByABMAe4AJgC+ACYAAAACAAAAAwAAABQAAwABAAAAFAAEAEgAAAAOAAgAAgAG4C7gYeBl4GjgbOBz//8AAOAu4GHgZeBo4Gzgcv//H9kfoB+dH5sfmB+TAAEAAAAAAAAAAAAAAAAAAAAAACgAZACgAMEA1wD1AS4BOQAAAAMATAAAAjoC0gADABMAFwAAASERISU1MzUzNTM1MxUzFTMVMxUFESERAe7+qgFW/tAmJiYmJiYm/oQB7gKG/caYJkxMJiZMTCbkAtL9LgAAAQBMAAACFAIUADMAADc1MzUzNTM1MzUjNSMVIxUjNTM1MzUzFTMVMxEzFSM1IzUjNTM1IxUjFSMVMxUjFSM1IzVMJky+Jia+JkwmTL5MJiZMJiYmJr4m5Ca+JkyYJiYmTCYmJkwmJiZM/qpMJiYmmCYmciYmJiYAAgAmAAAB7gIUACUAMQAANzUjNTM1MzUzNTMVMxUzFTMVIRUzFTMVMzUzNTMVIxUjFSM1IzURFSE1IzUjNSMVIxVMJiYmJuQmJib+hCYmviZMJkzkJgEwJiaYJkxM5EwmJiYmTJhMJiYmJkwmJiYmATBMTCYmJiYAAgBMAAAB7gLSAAcAFQAAMxEzETMVIxEhESM1IzUzNTMVMxUzEUxMJiYBCia+Jr4mJgLS/vYm/l4BoiYmJiYm/jgAAQAmAAABVgLSAA0AADM1MxEjNTMVMxUzETMVJnJyciYmckwCOkwmJv3GTAACAEwAAAGiAhQADQATAAAzNTMRIzUzFTMVIxEzFQM1MzUzFUxMTJgmJnJMJnJMAXxMTCb+qkwByCYmTAABACYAAAHIAhQALwAANzUzFTMVMzUjNSM1IzUjNTM1MzUhFTMVMxUjNSMVIxUzFTMVMxUzFSMVIxUhNSM1Jkwm5EyYTCYmJgEKJiZM5CYmmHImJib+9iZMTCYmciYmTExMJiYmTEwmTCYmJpgmJiYmAAABACYAAACYAHIAAwAAMzUzFSZycnIAAAAAAAAABgAAAAMAAAAAAAD/nAAyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAB//8ADwABAAAADAAAAAAAAAACAAEAAQAGAAEAAAABAAAACgAkADIAAkRGTFQADmxhdG4ADgAEAAAAAP//AAEAAAABa2VybgAIAAAAAQAAAAEABAACAAgAAQAIAAIAIgAEAAAAMABAAAMAAwAAAAAAAAAAAAAAAAAA/9r/2gABAAUAAQACAAQABQAGAAEAAQAFAAEAAAAAAAEAAgABAAEABgACAAEAAAAAAAAAAQABAAAACgAmACgAAkRGTFQADmxhdG4AGAAEAAAAAP//AAAAAAAAAAAAAAAA";

const PUA_OFFSET = 0xe000;

function decodeBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Font family name the OG wordmark opts into via `fontFamily`. */
export const PIXEL_WORDMARK_FAMILY = "Geist Pixel";

/** Decoded TTF buffer for the `fonts` option of `ImageResponse`. */
export const PIXEL_WORDMARK_FONT: ArrayBuffer = decodeBase64(PIXEL_WORDMARK_TTF_BASE64);

/**
 * Shift an ASCII wordmark ("releases.sh") into the PUA codepoints the pixel font
 * is encoded at, so — and only so — it renders in Geist Pixel. Any character
 * outside the subset is left untouched (it'll fall back to the default font).
 */
export function pixelWordmark(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x80 ? String.fromCodePoint(PUA_OFFSET + cp) : ch;
  }
  return out;
}
