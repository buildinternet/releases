/**
 * Pure MDX/Markdown helpers for directory-mode changelog entries (one file
 * per release, metadata in YAML frontmatter).
 *
 * Deliberately regex/line-based and conservative — no MDX compiler and no
 * YAML library, so the GitHub Action can import this from a repo checkout
 * without installing dependencies, and the CLI can run it on Node.
 *
 * Frontmatter parsing covers the changelog subset (flat scalars, `|`/`>`
 * blocks, and skipping nested maps/lists). A document this parser cannot
 * read yields empty frontmatter, same as a YAML parse error: the body is
 * kept and title falls back to the heading or filename.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// Fenced blocks and inline code spans are passed through untouched.
const FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

export type Frontmatter = Record<string, unknown>;

export type ParsedMdx = {
  data: Frontmatter;
  body: string;
};

type Scalar = { ok: true; value: string | number | boolean | null } | { ok: false };

function parseDoubleQuoted(input: string): Scalar {
  let out = "";
  let i = 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) return { ok: false };
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") out += "\r";
      else if (next === "u") {
        const hex = input.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { ok: false };
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      } else out += next;
      i += 2;
      continue;
    }
    if (ch === '"') {
      const rest = input.slice(i + 1).trim();
      if (rest === "" || rest.startsWith("#")) return { ok: true, value: out };
      return { ok: false };
    }
    out += ch;
    i++;
  }
  return { ok: false };
}

function parseSingleQuoted(input: string): Scalar {
  let out = "";
  let i = 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") {
      if (input[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const rest = input.slice(i + 1).trim();
      if (rest === "" || rest.startsWith("#")) return { ok: true, value: out };
      return { ok: false };
    }
    out += ch;
    i++;
  }
  return { ok: false };
}

/** `#` starts a comment only when whitespace precedes it (YAML plain scalars). */
function stripPlainComment(value: string): string {
  const idx = value.search(/\s#/);
  return (idx === -1 ? value : value.slice(0, idx)).trim();
}

function parseScalar(raw: string): Scalar {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) return parseDoubleQuoted(trimmed);
  if (trimmed.startsWith("'")) return parseSingleQuoted(trimmed);

  const plain = stripPlainComment(trimmed);
  if (plain.includes(": ")) return { ok: false };
  if (/^(?:true|false)$/i.test(plain)) return { ok: true, value: /^true$/i.test(plain) };
  if (/^(?:null|~)$/i.test(plain)) return { ok: true, value: null };
  if (/^[+-]?\d+$/.test(plain)) return { ok: true, value: Number(plain) };
  if (/^[+-]?(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?$/.test(plain)) {
    return { ok: true, value: Number(plain) };
  }
  if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(plain)) return { ok: true, value: Number(plain) };
  return { ok: true, value: plain };
}

function readBlock(
  lines: string[],
  start: number,
  style: "|" | ">",
  chomp: "clip" | "strip" | "keep",
): { value: string; next: number } {
  const collected: string[] = [];
  let i = start;
  let contentIndent: number | null = null;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      collected.push("");
      i++;
      continue;
    }
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (indent === 0) break;
    if (contentIndent === null) contentIndent = indent;
    if (indent < contentIndent) break;
    collected.push(line.slice(contentIndent));
    i++;
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();

  let text: string;
  if (style === "|") {
    text = collected.join("\n");
  } else {
    const paragraphs: string[] = [];
    let buf: string[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      paragraphs.push(buf.join(" "));
      buf = [];
    };
    for (const line of collected) {
      if (line.trim() === "") flush();
      else buf.push(line.trim());
    }
    flush();
    text = paragraphs.join("\n");
  }

  if (text.length > 0 && (chomp === "clip" || chomp === "keep")) text += "\n";
  return { value: text, next: i };
}

function skipIndented(lines: string[], start: number): number {
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^\s/.test(line)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Top-level YAML map for changelog frontmatter. Returns null when a scalar
 * cannot be read (the caller drops the whole block, matching a parser throw).
 * Nested maps and flow collections are skipped so a later `title`/`draft`
 * still lands; they are not fields the planner reads.
 */
function parseYamlObject(yaml: string): Record<string, unknown> | null {
  const lines = yaml.split("\n").map((line) => line.replace(/\r$/, ""));
  const data: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) return null;
    const keyMatch = /^([^:#\n]+?):\s*(.*)$/.exec(line);
    if (!keyMatch) return null;
    const key = keyMatch[1]?.trim() ?? "";
    if (!key) return null;
    const header = (keyMatch[2] ?? "").trim();
    const block = /^([|>])([-+])?\d*(?:\s+#.*)?$/.exec(header);
    if (block) {
      const style = block[1] === ">" ? ">" : "|";
      const chomp = block[2] === "-" ? "strip" : block[2] === "+" ? "keep" : "clip";
      const read = readBlock(lines, i + 1, style, chomp);
      data[key] = read.value;
      i = read.next;
      continue;
    }
    if (header === "" || header.startsWith("#")) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      if (j < lines.length && /^\s/.test(lines[j] ?? "")) {
        i = skipIndented(lines, i + 1);
        continue;
      }
      data[key] = null;
      i++;
      continue;
    }
    if (header.startsWith("[") || header.startsWith("{")) {
      i++;
      continue;
    }
    const scalar = parseScalar(header);
    if (!scalar.ok) return null;
    data[key] = scalar.value;
    i++;
  }
  return data;
}

/** Splits a leading `---\n...\n---` YAML block off the raw file content. */
export function parseFrontmatter(raw: string): ParsedMdx {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: raw };

  const yamlBlock = match[1] ?? "";
  const body = raw.slice(match[0].length);
  const data = parseYamlObject(yamlBlock);
  if (!data) return { data: {}, body };
  return { data, body };
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
