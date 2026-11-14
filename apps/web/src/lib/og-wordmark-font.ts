/**
 * Schibsted Grotesk SemiBold, inlined for the OG-image wordmark so it matches
 * the site header.
 *
 * Satori (the engine behind `next/og`) treats the FIRST provided font as the
 * global default for any text whose `fontFamily` doesn't match a loaded font,
 * and `next/og` puts caller fonts first. A normally encoded wordmark subset
 * could therefore get picked as the fallback for every 'a'/'e'/'r'/'s'… across
 * titles and metrics, producing a ransom-note mix. To make that impossible,
 * every glyph here is remapped into the Private Use Area at codepoint
 * (0xE000 + its ASCII value). Normal body text never contains U+E0xx, so this
 * face can never match it; the wordmark opts in by shifting its own characters
 * into that range via `wordmarkText`.
 *
 * The data is the static 600 instance from Google Fonts, subset with fontTools
 * to the wordmark's glyphs ("Release Notes Index", kern feature kept) and
 * PUA-remapped. Base64-inlined (≈2.5 KB) so the OG routes load it synchronously
 * at module scope with no filesystem/network hop and stay runtime-agnostic
 * (edge or node). OG routes are server-only, so this never reaches the client
 * bundle.
 *
 * To change the wordmark string, re-subset the TTF with
 * `fontTools.subset` (`--text=...`), then rewrite each cmap entry `cp` to
 * `0xE000 + cp`. SIL Open Font License 1.1 (Schibsted Grotesk Project Authors).
 */
const WORDMARK_TTF_BASE64 =
  "AAEAAAAPAIAAAwBwR0RFRgARAAwAAAeIAAAAFkdQT1MuLSaRAAAHoAAAAihPUy8yTm06VwAAAXgAAABgU1RBVOV0zBYAAAnIAAAARGNtYXBia2JCAAACEAAAAHxnYXNwAAAAEAAAB4AAAAAIZ2x5ZlOM8f8AAAK0AAAEKGhlYWQqMd57AAAA/AAAADZoaGVhDUAEBAAAATQAAAAkaG10eDppBHkAAAHYAAAAOGxvY2EIXAeHAAAClAAAAB5tYXhwABIAOgAAAVgAAAAgbmFtZQr0GwwAAAbcAAAAgnBvc3T/0QCcAAAHYAAAACBwcmVwaAaMhQAAAowAAAAHAAEAAAABGZrhfIUdXw889QADCAAAAAAA3o8RTAAAAADnHWjXAAD/5wVuBdwAAAAGAAIAAAAAAAAAAQAAB9D98AAABgUAAAAABW4AAQAAAAAAAAAAAAAAAAAAAA4AAQAAAA4AOQADAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAEBNkCWAAFAAAFMwTNAAAAmgAAAAAAAAAAANsCvgAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAABCQlQAAMDgIOB4B9D98AAACcYCOAAAAAEAAAAABDgFoAAAACAAAwQAAAADMABSBgUAlwVXAJcEoQBJBOcASASzAFQCRQCSBNMAlgTYAFMEQgBBAusAMwS0ACUB0QAAAAAAAgAAAAMAAAAUAAMAAQAAABQABABoAAAAFgAQAAMABuAg4EngTuBS4GHgZeBs4G/gdOB4//8AAOAg4EngTuBS4GHgZOBs4G7gc+B4//8f7R+4H7QfsR+jH6Efmx+aH5cflAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAALgB/4WwBI0AAAAAFAApAEMAbgC+APIBKAE+AWEBjQHVAfQCFAIUAAAAAgAAAAAEAAWgAAMABwAAMREhESUhESEEAPxiAzz8xAWg+mBiBNwAAAEAUgAAAt0FoAALAAAzNTMRIzUhFSMRMxVSxMQCi8TE0wP609P8BtMAAAEAlwAABW4FoAALAAAzESEBBxEzESEBNxGXAXACtkf4/p79OUoFoPr5BgUN+mAFDgf66wADAJcAAAUWBaAACAAMABUAADMRISARECEhESEBIQEBITI2NTQmIyGXAnQB/f3s/qYCWP5uASEBlfyEAWZ9h4l+/p0FoP5u/mz9hgLB/T8DR2VgYGgAAAIASf/nBGMEUgAqADgAAAUiJiY1NDY2MzMHNTQmIyIGByU+AjMyFhYVERQWMzMVIyImNTUXDgMnMjY2NTUjIgYGFRQWFgG8aahif/m4ohJYZmFoCP79DXfOkYq6XRMfNoFibioONlqFGUt5R451hDYjThlMkWVto1oYPXR2ZloxWZBWXsWc/mEiFrxpXD0MK15SNLNHk3ASPVksJkctAAACAEj/5wRSBdwAFAAhAAAFIiYmNTQ2NjMyFhcHETMRIzUXBgYnMjY2NTQmIyIGFRQWAgOFyW1uyYdyxDga+OsEMsEhTHpInHB2k44ZiP+wsPyHbH4EAnn6JNwPdnDAUKV+vbrFtK7DAAEAVP/nBGUEUQAjAAAFIiYmNTQ2NjMyHgIVITUhBy4CIyIGBhUUFjMyNjcXDgICbZ3yiojwnVizlVz8jgKWJgZHb0RWdj2Kh1yCIOYnkMAZiv6trf6KNonxuZ05eZNDXa12sMdeXUBpikUAAAEAkgAAAhcF3AALAAAhIiY1ETMRFBYzMxUBaWN0+BMfW2lcBRf7GCIWvAAAAQCWAAAEUgRRABUAADMRMxUnNjYzMhYWFREjETQmIyIGFRGW7QcvtoJ5o1P4WWl5kgQ49yxmfm3FhP1lAop6jcTD/fYAAAIAU//nBIUEUQAPABsAAAUiJiY1NDY2MzIWFhUUBgYnMjY1NCYjIgYVFBYCbJ/zh4fzn5/yiIjznn+UlH+Ak5MZj/+np/+Pj/+np/+PvMuur8rKr67LAAABAEH/5wPwBFEAMAAABSImJic3FhYzMjY1NCYnJy4DNTQ2NjMyFhYXBy4CIyIGFRQWFhcXHgIVFAYGAih4z4sV6wp/amlvU1tvOHxuRXLDene9fRPuByxXR1NsMVo9eFWWXXbOGUmZeC5paFxAOEoPEwohP21Ua5JLR4hjMDBPL0M+KTUiDBcORXxlcJ1RAAABADMAAAKjBUsAEwAAISImNREjNTM1NxEzFSMRFBYzMxUBq2J0oqL3zs4TH6VpXAK3vNk6/u28/XgiFrwAAAEAJQAABIwEOAALAAAzAQEhARMhAQEhAQElAZ7+gwEYAQX6AR/+dQGb/tr+7v7tAjACCP6FAXv96/3dAY7+cgAAAAUAQgADAAEECQACAA4AAAADAAEECQEAAAwADgADAAEECQEDABAAGgADAAEECQEHAAwAKgADAAEECQEIAAoANgBSAGUAZwB1AGwAYQByAFcAZQBpAGcAaAB0AFMAZQBtAGkAQgBvAGwAZABJAHQAYQBsAGkAYwBSAG8AbQBhAG4AAAADAAAAAAAA/84AnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAf//AA8AAQAAAAwAAAAAAAAAAgABAAEACwABAAAAAQAAAAoAJAAyAAJERkxUAA5sYXRuAA4ABAAAAAD//wABAAAAAWtlcm4ACAAAAAEAAAABAAQACQAIAAMADAAUABwAAQACAAAAGAABAAIAAAAyAAEAAgAAAYYAAQAOAAQAAAACABYAHAABAAIAAgAKAAEAAgAAAAEABgAKAAIBGAAEAAABIgE+AAsADAAA///////bABQAEgAAAAD/6gAlAAD/wAAA//n/9//PABoAHAAA//z/7gAoAAn/wQAAAAAAAAAD//n/+f/7AAQADgABAAD/7wAAAAAAAP/4AAAAAP//AAD/7AASAAP/8AAA//3//f/yAAwADAAH////9wAeAB7/3gAAAAv//wAD/+T/5P/5AAsADf/+//UAAwAAAAEAAP/7/97/3v/1AAAAAP/w//kAAAAAAAP/9gA0/87/z//nAAH/3P/l//T/9wAAAAEAAAAAAAAAAAAAAAD/3wACAAH//wAAAAD//AAA//r/9//5//oACgABAAD/7wAAAAkABAAH//z/+AAD//3/8gAHAAYAAgACAAEAAQALAAAAAQABAAsABwACAAUACAAJAAAACgADAAEABAAGAAEAAQAMAAMAAQABAAoACQAEAAcAAgAFAAYACAALAAIAKAAEAAAALgAyAAEADAAA//P/8v/1/8L/wf/b/+z/9f/W/+QACAABAAEADAACAAAAAQABAAwAAwABAAEACgAJAAQABwACAAUABgAIAAsAAQABAAgAAgAAABQAAgAAACQAAndnaHQBAAAAaXRhbAEHAAEABAAQAAEAAAAAAQMCWAAAAAMAAQACAQgAAAAAAAEAAA==";

const PUA_OFFSET = 0xe000;

function decodeBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Font family name the OG wordmark opts into via `fontFamily`. */
export const WORDMARK_FAMILY = "Schibsted Grotesk Wordmark";

/** Weight the inlined instance is registered at. */
export const WORDMARK_WEIGHT = 600 as const;

/** Decoded TTF buffer for the `fonts` option of `ImageResponse`. */
export const WORDMARK_FONT: ArrayBuffer = decodeBase64(WORDMARK_TTF_BASE64);

/**
 * Shift an ASCII wordmark ("Release Notes Index") into the PUA codepoints the
 * subset is encoded at, so (and only so) it renders in the wordmark face. Any
 * character outside the subset is left untouched and falls back to the default
 * font.
 */
export function wordmarkText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += cp < 0x80 ? String.fromCodePoint(PUA_OFFSET + cp) : ch;
  }
  return out;
}
