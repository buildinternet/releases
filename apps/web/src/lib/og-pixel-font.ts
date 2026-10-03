/**
 * Geist Pixel (Square variant) — inlined for the OG-image wordmark.
 *
 * Two problems shape this file:
 *
 * 1. Satori (the engine behind `next/og`) can't parse woff2, the only format the
 *    `geist` package ships for the pixel faces. So this is the woff2 decompressed
 *    to TTF, then instanced at the Square shape (ELSH=1), overlaps removed, and subset to just
 *    the wordmark's glyphs ("Release Notes Index").
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
 * Base64-inlined (≈2 KB) so the OG routes load it synchronously at module scope
 * with no filesystem/network hop and stay runtime-agnostic (edge or node). OG
 * routes are server-only, so this never reaches the client bundle.
 *
 * To change the wordmark string, re-instance + re-subset
 * `app/fonts/geist-pixel/GeistPixel-Variable.woff2` with fontTools
 * (`instantiateVariableFont` ELSH=1, `subset`, `removeOverlaps` — needs
 * skia-pathops) and re-apply the PUA remap. SIL Open Font License (geist).
 */
const PIXEL_WORDMARK_TTF_BASE64 =
  "AAEAAAAOAIAAAwBgR0RFRgARAA0AAAeYAAAAFkdQT1Mr6iShAAAHsAAAAH5HU1VCuPq49AAACDAAAAAqT1MvMjUFRCwAAAFoAAAAYGNtYXBia2JCAAACAAAAAHxnYXNwAAAAEAAAB5AAAAAIZ2x5Zl+IJgcAAAKcAAAEymhlYWQ2Uq/XAAAA7AAAADZoaGVhBk8FewAAASQAAAAkaG10eBucAtIAAAHIAAAAOGxvY2EJogi7AAACfAAAAB5tYXhwABIAQgAAAUgAAAAgbmFtZQAGAAAAAAdoAAAABnBvc3T/nwAyAAAHcAAAACAAAQAAAAEAAO1ANcpfDzz1CAMD6AAAAADl9VTtAAAAAObnFzUAJgAAAjoC0gAAAAYAAgAAAAAAAAABAAAD7f7ZAAAChgAmACYCOgPoAAAAAAAAAAAAAAAAAAAADgABAAAADgBBAAMAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAQCJwGQAAUAAAKKAlgAAABLAooCWAAAAV4AMgE/AAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAFZSQ0wAwOAg4HgD7f7ZAAAEQAGKAAAAAQAAAAACFALSAAAAIAADAoYATADkAEwChgBMAoYATAI6AEwCOgAmAhQAJgF8ACYCOgBMAhQAJgHuACYBfAAmAe4AJgF8AAAAAAACAAAAAwAAABQAAwABAAAAFAAEAGgAAAAWABAAAwAG4CDgSeBO4FLgYeBl4Gzgb+B04Hj//wAA4CDgSeBO4FLgYeBk4GzgbuBz4Hj//x/tH7gftB+xH6MfoR+bH5oflx+UAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKQA2AGsAoQDeARUBVAFrAY4ByQICAh0CZQJlAAAAAwBMAAACOgLSAAQACQAaAAAzIxEhESUhESERNyM1MzUzNTM1MxUzFTMVMxVWCgHu/mgBTP6qMAomJiYmJiYmAtL9LkwCOv3GmCZMTCYmTEwmAAEATAAAAJgC0gAEAAAzIxEzEVYKTALS/S4AAgBMAAACOgLSACAAKQAAMyMRMxUzFTMVMxUzFTMVMxUzFSM1IzUjNSM1IzUjNSMRISM1IzUzETMRVgpyJiYmJiYmJkwmJiYmJiYBYAomJkwC0iZMTExMTExMTExMTExM/aBMTAI6/S4AAAEATAAAAjoC0gAqAAAzIxEhFTMVMxUzFSMVIxUjNTM1MzUjNSM1IREhFTMVMxUzESM1IzUjNSERVgoBVkwmJiYmTCYmJib+9gEKTCYmTCYm/vYC0iYmJpgmJiYmciYm/vYmJib+9uQmJv7QAAEATAAAAhQCFAA0AAAzIzUjNSM1MzUzNTM1MzUjNSMVIxUjNTM1MzUzFTMVMxEzFSM1IzUjNTM1IxUjFSMVMxUjFaIKJiYmTL4mJr4mTCZMvkwmJkwmJiYmvibkJiYmmCYmJkwmJiZMJiYmTP6qTCYmJpgmJnImJgAAAgAmAAAB7gLSACAALAAAMyM1IzUjNSM1MzUzNTM1MxUzFSMVIxUjFTMVMxUzFSMVEzMRMxEjNSM1MzUjogomJiYmJia+Jr4mJiYmviYmJkxMJiYmJiZM5EwmJiYmJibkJiYmJgHIAQr9LkxM5AACACYAAAHuAhQAJgAzAAAzIzUjNSM1IzUzNTM1MzUzFTMVMxUzFSEVMxUzFTM1MzUzFSMVIxUBITUjNSM1IxUjFSMVogomJiYmJibkJiYm/oQmJr4mTCZM/wABJiYmmCYmJiZM5EwmJiYmTJhMJiYmJkwmJgEwTCYmJiZMAAABACYAAAFWAtIADgAAMyM1MxEjNTMVMxUzETMVMApycnImJnJMAjpMJib9xkwAAgBMAAAB7gIUAA4AFwAAISMRIzUjNTM1MxUzFTMRISMRMxUzFSMRAawKJr4mviYm/mgKTCYmAaImJiYmJv44AhRMJv5eAAIAJgAAAe4CFAAcADEAADMjNSM1IzUjNTM1MzUzNTMVMxUzFTMVIxUjFSMVJzM1MzUzNSM1IzUjFSMVIxUzFTMVogomJiYmJibkJiYmJiYmtI4mJiYmmCYmJiYmJkzkTCYmJiZM5EwmJkwmJuQmJiYm5CYmAAABACYAAAHIAhQAMAAAMyM1IzUjNTMVMxUzNSM1IzUjNSM1MzUzNSEVMxUzFSM1IxUjFTMVMxUzFTMVIxUjFXwKJiZMJuRMmEwmJiYBCiYmTOQmJphyJiYmJiZMJiZyJiZMTEwmJiZMTCZMJiYmmCYmAAABACYAAAFWAoYAEgAAMyM1IzUjESM1MzUzFTMVIxEzFcgKJiZMTEyYmJgmJgF8THJyTP6ETAABACYAAAHIAhQAQAAAMyM1MzUzNTM1MzUjNSM1IzUjNTMVMxUzFTMVMzUzNTM1MzUzFSMVIxUjFSMVMxUzFTMVMxUjNSM1IzUjFSMVIxUwCiYmJiYmJiYmTCYmJiYmJiZMJiYmJiYmJiZMJkwmTCZyJiYmTCYmJnJMJiZMTCYmTHImJiZMJiYmckxMTExMTAAAAAAAAAAGAAAAAwAAAAAAAP+cADIAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAH//wAPAAEAAAAMAAAAAAAAAAIAAQABAAwAAQAAAAEAAAAKACQAMgACREZMVAAObGF0bgAOAAQAAAAA//8AAQAAAAFrZXJuAAgAAAABAAAAAQAEAAIACAABAAgAAgAQAAAAAAAeACwAAgADAAEABQAEAAYABwAJAAoAAQAEAAQAAQAAAAAAAQABAAQABwACAAEAAQAAAAAAAQABAAAAAQAAAAoAJgAoAAJERkxUAA5sYXRuABgABAAAAAD//wAAAAAAAAAAAAAAAA==";

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
 * Shift an ASCII wordmark ("Release Notes Index") into the PUA codepoints the pixel font
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
