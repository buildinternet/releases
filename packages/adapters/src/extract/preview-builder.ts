import { parse as partialParse } from "partial-json";
import type { UsageExtractionMode } from "@buildinternet/releases-core/schema";

export type SketchResult =
  | { ok: true; mode: "strict" | "partial"; sketch: string; truncatedAt?: number }
  | { ok: false; mode: "none"; sketch?: never };

// MAX_DEPTH controls how many levels of object keys we expand.
// depth=0 is the root object's keys; depth=1 is their children's keys; beyond that we stop.
const MAX_DEPTH = 2;

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") return "object";
  return typeof value;
}

function formatLines(obj: Record<string, unknown>, depth: number, indent: string): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && !Array.isArray(v) && typeof v === "object" && depth < MAX_DEPTH) {
      lines.push(`${indent}${k}:`);
      lines.push(...formatLines(v as Record<string, unknown>, depth + 1, indent + "  "));
    } else {
      lines.push(`${indent}${k}: ${describeType(v)}`);
    }
  }
  return lines;
}

function formatSketch(root: unknown): string {
  if (Array.isArray(root)) return `[root]: array(len=${root.length})`;
  if (root && typeof root === "object") {
    return formatLines(root as Record<string, unknown>, 0, "").join("\n");
  }
  return `[root]: ${describeType(root)}`;
}

export function buildJsonSketch(body: string): SketchResult {
  try {
    const parsed = JSON.parse(body);
    return { ok: true, mode: "strict", sketch: formatSketch(parsed) };
  } catch {
    // Strict parse failed — try partial recovery below.
  }

  try {
    const parsed = partialParse(body);
    // partial-json returns undefined/null when nothing could be recovered
    if (parsed === undefined || parsed === null) {
      return { ok: false, mode: "none" };
    }
    const truncatedAt = estimateTruncation(body);
    return { ok: true, mode: "partial", sketch: formatSketch(parsed), truncatedAt };
  } catch {
    return { ok: false, mode: "none" };
  }
}

function estimateTruncation(body: string): number {
  // Walk backward from the end looking for the last structural or token-ish char.
  // This is a rough byte offset to help the model orient around truncation.
  for (let i = body.length - 1; i >= 0; i--) {
    const c = body[i]!;
    if (c === "," || c === "]" || c === "}" || /[0-9a-zA-Z"]/.test(c)) return i;
  }
  return body.length;
}

export interface BuildPreviewOpts {
  body: string;
  sourceUrl: string;
  fetchUrl: string;
  approxTokens?: number;
}

export interface PreviewResult {
  message: string;
  contentType: "json" | "html";
  mode: UsageExtractionMode;
  queryJsonAvailable: boolean;
  sketch: string;
}

export function buildPreview(opts: BuildPreviewOpts): PreviewResult {
  const { body, sourceUrl, fetchUrl, approxTokens } = opts;
  const header =
    `Canonical source URL: ${sourceUrl}\n` +
    `Fetched from: ${fetchUrl}\n` +
    `Body length: ${body.length.toLocaleString()} chars` +
    (approxTokens ? ` (~${approxTokens.toLocaleString()} tokens)` : "");

  const json = buildJsonSketch(body);

  if (json.ok) {
    const mode: UsageExtractionMode = json.mode === "partial" ? "toolloop:partial" : "toolloop";
    const truncNote =
      json.mode === "partial" && json.truncatedAt !== undefined
        ? `\n\nNote: body parse was truncated at ~byte ${json.truncatedAt.toLocaleString()}. ` +
          `Structure past this point may be missing. If query_json returns empty for a deep path, fall back to get_slice.`
        : "";

    const message =
      `${header}\n` +
      `Content type: JSON\n\n` +
      `Schema sketch (depth 2):\n${json.sketch}${truncNote}\n\n` +
      toolInstructions(true);

    return { message, contentType: "json", mode, queryJsonAvailable: true, sketch: json.sketch };
  }

  // Fall back to HTML preview.
  const html = buildHtmlPreview(body);
  const message =
    `${header}\n` +
    `Content type: HTML\n\n` +
    `Preview (first/last 2K chars, chrome stripped):\n${html}\n\n` +
    toolInstructions(false);

  // If the body was so unusable that the HTML preview is essentially the same string we got back,
  // flag it as no_sketch. Good-enough heuristic: unchanged length and no recognizable tag.
  const looksUnusable = html.length === body.length && !/<[a-z]/i.test(body);
  const mode: UsageExtractionMode = looksUnusable ? "toolloop:no_sketch" : "toolloop";

  return { message, contentType: "html", mode, queryJsonAvailable: false, sketch: html };
}

function toolInstructions(queryJsonAvailable: boolean): string {
  const tools = queryJsonAvailable
    ? "`query_json(path)` to target a JSONPath (e.g. `$.result.data.allRoadmap.nodes[*]`), or `get_slice(start, length)` for raw byte ranges."
    : "`get_slice(start, length)` to pull raw byte ranges from the body.";
  return (
    `The body is available via tools — not inlined below. Use ${tools} ` +
    `Call \`extract_releases\` with the entries you found when done.`
  );
}

const STRIP_TAGS = ["script", "style", "svg", "nav", "header", "footer"];
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 2000;

export function buildHtmlPreview(body: string): string {
  let cleaned = body;
  for (const tag of STRIP_TAGS) {
    // Remove full tag blocks (including content) — non-greedy, case-insensitive.
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    // Also remove self-closing variants.
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, "gi"), "");
  }

  if (cleaned.length <= PREVIEW_HEAD + PREVIEW_TAIL) return cleaned;

  const head = cleaned.slice(0, PREVIEW_HEAD);
  const tail = cleaned.slice(-PREVIEW_TAIL);
  return `${head}\n\n[... ${cleaned.length - PREVIEW_HEAD - PREVIEW_TAIL} chars elided ...]\n\n${tail}`;
}
