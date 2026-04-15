/**
 * Token counting via js-tiktoken `cl100k_base`. Used as a proxy for
 * Claude's proprietary tokenizer (empirically within ~5% on English prose).
 * The encoder is lazy-loaded so non-changelog CLI commands don't pay the
 * ~1MB ranks cost; `lite` + a direct rank import avoids the 11MB bundle.
 */
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (encoder === null) encoder = new Tiktoken(cl100k_base);
  return encoder;
}

/**
 * Safety cap for {@link countTokensSafe}. js-tiktoken's BPE merge is
 * worst-case O(n²) on pathologically repetitive input; anything at or
 * above this size falls back to the heuristic to keep request latency
 * bounded at ~a few hundred ms.
 */
const LIVE_ENCODE_MAX_CHARS = 256 * 1024;

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

/** Exact for inputs under 256KB, chars/4 heuristic above. */
export function countTokensSafe(text: string): number {
  if (text.length === 0) return 0;
  if (text.length >= LIVE_ENCODE_MAX_CHARS) return estimateTokens(text);
  return getEncoder().encode(text).length;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
