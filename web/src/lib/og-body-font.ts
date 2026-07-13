import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Body font for OG images — Geist Sans (Regular).
 *
 * `next/og` ships Geist-Regular.ttf as its built-in default font, so every OG
 * title/subtitle/metric renders in it today. But the moment you pass a `fonts`
 * array to `ImageResponse` (which we do, for the pixel wordmark), Satori stops
 * using that built-in default and falls back to a different face — silently
 * changing every non-wordmark glyph. To keep the titles byte-identical to what
 * ships now, we re-supply the exact same Geist-Regular.ttf as the base font
 * (a copy of next/og's own file lives at web/assets/), with the pixel face
 * layered on top for the wordmark only.
 *
 * Loaded once at module scope with readFileSync (all OG routes run on the node
 * runtime; @vercel/nft traces `process.cwd()`-joined reads into the bundle).
 * SIL Open Font License (Geist).
 */
export const OG_BODY_FAMILY = "Geist";

export const OG_BODY_FONT: Buffer = readFileSync(
  join(process.cwd(), "assets", "Geist-Regular.ttf"),
);
