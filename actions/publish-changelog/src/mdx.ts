/**
 * Pure MDX/Markdown helpers for directory-mode changelog entries (one file
 * per release, metadata in YAML frontmatter).
 *
 * Deliberately regex/line-based and conservative — no MDX compiler
 * dependency. Two responsibilities:
 *   1. `parseFrontmatter` — split the leading `---` YAML block from the body.
 *   2. `flattenMdxToMarkdown` — drop `import`/`export` lines and flatten JSX
 *      components to their text children, leaving fenced code blocks,
 *      regular markdown, links, and images untouched.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Fenced blocks and inline code spans are passed through untouched.
const FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

export type Frontmatter = Record<string, unknown>;

export type ParsedMdx = {
  data: Frontmatter;
  body: string;
};

/** Splits a leading `---\n...\n---` YAML block off the raw file content. */
export function parseFrontmatter(raw: string): ParsedMdx {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: raw };

  const yamlBlock = match[1] ?? "";
  const body = raw.slice(match[0].length);

  let data: unknown;
  try {
    // Bun.YAML.parse (available on the pinned bun-version for this Action).
    data = Bun.YAML.parse(yamlBlock);
  } catch {
    return { data: {}, body };
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { data: data as Frontmatter, body };
  }
  return { data: {}, body };
}

/** Splits `text` into code (```/~~~ fences, inline `spans`) and prose segments, in order. */
function splitByFences(text: string): { fence: boolean; text: string }[] {
  const parts: { fence: boolean; text: string }[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(FENCE_RE)) {
    const index = m.index ?? 0;
    if (index > lastIndex) parts.push({ fence: false, text: text.slice(lastIndex, index) });
    parts.push({ fence: true, text: m[0] });
    lastIndex = index + m[0].length;
  }
  if (lastIndex < text.length) parts.push({ fence: false, text: text.slice(lastIndex) });
  return parts;
}

function stripImportExportLines(text: string): string {
  return text.replace(/^[ \t]*(?:import|export)\s.*$/gm, "");
}

/** `<img src="…" alt="…">` / `<Image src="…" alt="…" />` → `![alt](src)`. */
function convertImageTags(text: string): string {
  return text.replace(/<(?:img|Image)\b([^>]*?)\/?>/gi, (_match: string, attrs: string) => {
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    const alt = attrs.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    return src ? `![${alt}](${src})` : "";
  });
}

/** `<a href="…">text</a>` → `[text](href)`, so links survive flattening. */
function convertAnchorTags(text: string): string {
  return text.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match: string, attrs: string, inner: string) => {
      const href = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
      return href ? `[${inner}](${href})` : inner;
    },
  );
}

/** Drops self-closing JSX components, e.g. `<Video src="…" />`. */
function dropSelfClosingTags(text: string): string {
  return text.replace(/<([A-Za-z][\w.-]*)((?:\s+[^>]*?)?)\/>/g, "");
}

/** Flattens paired JSX components to their inner text, innermost-first. */
function flattenPairedTags(text: string): string {
  let current = text;
  const pairedTagRe = /<([A-Za-z][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  for (let i = 0; i < 25; i++) {
    const next = current.replace(
      pairedTagRe,
      (_match: string, _tag: string, inner: string) => inner,
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Converts an MDX body to plain markdown: strips `import`/`export` lines,
 * flattens JSX components to their text children, converts image tags to
 * markdown images and anchors to markdown links, and drops other
 * self-closing components. Fenced code blocks and inline code spans are
 * passed through untouched.
 */
export function flattenMdxToMarkdown(body: string): string {
  const segments = splitByFences(body);
  const flattened = segments.map((segment) => {
    if (segment.fence) return segment.text;
    let text = stripImportExportLines(segment.text);
    text = convertImageTags(text);
    text = convertAnchorTags(text);
    text = dropSelfClosingTags(text);
    text = flattenPairedTags(text);
    return text;
  });
  return flattened
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First `# ` heading in the body, or null. */
export function extractTitleHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || null;
}
