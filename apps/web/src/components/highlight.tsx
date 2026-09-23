import type React from "react";
import type { Element, Nodes, Parents, Root, RootContent, Text } from "hast";
import { isWordBoundary } from "@releases/lib/entity-match";

type RehypeTransformer = (tree: Root) => void;
type RehypePlugin<Options> = (options: Options) => RehypeTransformer;

const MARK_CLASS =
  "bg-amber-200/70 dark:bg-amber-300/25 text-stone-900 dark:text-stone-100 rounded-sm px-0.5";
const MARK_CLASSES = MARK_CLASS.split(/\s+/);
const SKIP_TAGS = new Set(["code", "pre"]);

export function tokenizeQuery(query?: string | null): string[] {
  if (!query) return [];
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[\s,;|/]+/)
        .filter((t) => t.length >= 2),
    ),
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(tokens: string[]): RegExp | null {
  if (!tokens.length) return null;
  return new RegExp(`(?:${tokens.map(escapeRegex).join("|")})`, "gi");
}

export type MatchRange = { start: number; end: number };

/**
 * Find token occurrences that start at a word boundary. Substring matching
 * alone made "ai" render Em·ai·l-style fragments that look broken; anchoring
 * each occurrence with `isWordBoundary` mirrors the server's entity-match
 * semantics ("AI" in "OpenAI" highlights, "ai" in "Email" doesn't).
 */
export function matchRanges(text: string, tokens: string[]): MatchRange[] {
  const re = buildMatcher(tokens);
  if (!re || !text) return [];
  const ranges: MatchRange[] = [];
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (!isWordBoundary(text, start)) continue;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

type Segment = { type: "text"; value: string } | { type: "match"; value: string };

function segmentText(text: string, tokens: string[]): Segment[] {
  const ranges = matchRanges(text, tokens);
  if (!ranges.length) return [{ type: "text", value: text }];
  const segments: Segment[] = [];
  let last = 0;
  for (const { start, end } of ranges) {
    if (start > last) segments.push({ type: "text", value: text.slice(last, start) });
    segments.push({ type: "match", value: text.slice(start, end) });
    last = end;
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) });
  return segments;
}

export function Highlight({
  text,
  tokens,
}: {
  text: string | null | undefined;
  tokens: string[];
}): React.ReactNode {
  if (!text) return null;
  if (!tokens.length) return text;
  const segments = segmentText(text, tokens);
  if (segments.length <= 1 && segments[0]?.type !== "match") return text;
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "match" ? (
          <mark key={i} className={MARK_CLASS}>
            {seg.value}
          </mark>
        ) : (
          seg.value
        ),
      )}
    </>
  );
}

/**
 * react-markdown rehype plugin: walks text nodes in the rendered hast tree
 * and wraps query-token matches in `<mark>`. Skips `code` and `pre` subtrees
 * so we don't gild inline code or fenced blocks.
 */
export const rehypeHighlightTokens: RehypePlugin<{ tokens: string[] }> = (options) => {
  return (tree) => {
    if (!options.tokens.length) return;
    walk(tree, options.tokens);
  };
};

function walk(node: Parents, tokens: string[]): void {
  const out: RootContent[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      out.push(...splitHastText(child, tokens));
      continue;
    }
    if (isElement(child) && !SKIP_TAGS.has(child.tagName) && hasChildren(child)) {
      walk(child, tokens);
    }
    out.push(child);
  }
  node.children = out as typeof node.children;
}

function isElement(node: Nodes): node is Element {
  return node.type === "element";
}

function hasChildren(node: Nodes): node is Parents {
  return "children" in node && Array.isArray(node.children);
}

function splitHastText(node: Text, tokens: string[]): RootContent[] {
  const segments = segmentText(node.value, tokens);
  if (segments.length <= 1) return [node];
  return segments.map<RootContent>((seg) =>
    seg.type === "match"
      ? {
          type: "element",
          tagName: "mark",
          properties: { className: MARK_CLASSES },
          children: [{ type: "text", value: seg.value }],
        }
      : { type: "text", value: seg.value },
  );
}
