import type { Root, RootContent, Link, Text, Parent } from "mdast";

interface Options {
  /** Source repo URL (e.g. "https://github.com/vercel/next.js"). When set,
   *  bare `#123` references linkify to `{repoUrl}/issues/123`. Leave null on
   *  surfaces that aggregate multiple sources (lists, search) where the
   *  reference is ambiguous. */
  repoUrl?: string | null;
}

// One sweep over text nodes handles three kinds of references that GitHub
// itself linkifies in rendered Markdown but `remark-gfm` does not:
//
//   @user            -> https://github.com/user
//   org/repo#123     -> https://github.com/org/repo/issues/123
//   #123             -> {repoUrl}/issues/123 (only when repoUrl is provided)
//
// The lookbehind keeps the username pattern from eating the local part of an
// email address (handled by gfm's autolink), and the lookahead stops the
// number patterns from matching inside identifiers.
// Indices into the alternation, in order:
//   [1] user           — for @user
//   [2] orgRepo        — for org/repo#NNN
//   [3] crossNum       — number paired with orgRepo
//   [4] num            — bare #NNN (used only when repoUrl is provided)
//
// Trailing punctuation like a sentence-ending period must NOT disqualify a
// match ("Fixes #42." is the common case), so the negative lookahead only
// rejects word chars and `/`. A dot followed by another word char is still
// rejected so `#1.0` won't be parsed as an issue reference.
const REF_PATTERN =
  /(?<![\w/.])(?:@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)|([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d+)|#(\d+))(?![\w/])(?!\.\w)/g;

export function remarkGithubRefs(options: Options = {}) {
  const repoUrl = options.repoUrl?.replace(/\/+$/, "") ?? null;
  return (tree: Root) => {
    walk(tree, repoUrl);
  };
}

function walk(node: Parent | RootContent, repoUrl: string | null): void {
  const children = (node as Parent).children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Skip nodes that already have final semantics — rewriting them would
    // corrupt the AST.
    if (
      child.type === "link" ||
      child.type === "linkReference" ||
      child.type === "code" ||
      child.type === "inlineCode"
    ) {
      continue;
    }
    if (child.type === "text") {
      const replaced = expandRefs(child.value, repoUrl);
      if (replaced) {
        children.splice(i, 1, ...replaced);
        i += replaced.length - 1;
      }
    } else {
      walk(child as Parent, repoUrl);
    }
  }
}

function expandRefs(text: string, repoUrl: string | null): RootContent[] | null {
  const matches = Array.from(text.matchAll(REF_PATTERN));
  if (matches.length === 0) return null;
  const parts: RootContent[] = [];
  let last = 0;
  let found = false;
  for (const match of matches) {
    const [, user, orgRepo, crossNum, num] = match;
    let url: string | null = null;
    if (user) {
      url = `https://github.com/${user}`;
    } else if (orgRepo && crossNum) {
      url = `https://github.com/${orgRepo}/issues/${crossNum}`;
    } else if (num && repoUrl) {
      url = `${repoUrl}/issues/${num}`;
    }
    if (!url) continue;
    const start = match.index ?? 0;
    if (start > last) {
      parts.push({ type: "text", value: text.slice(last, start) } satisfies Text);
    }
    const link: Link = {
      type: "link",
      url,
      title: null,
      children: [{ type: "text", value: match[0] } satisfies Text],
    };
    parts.push(link);
    last = start + match[0].length;
    found = true;
  }
  if (!found) return null;
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) } satisfies Text);
  }
  return parts;
}

/** Extract `https://github.com/{org}/{repo}` from a release/source URL.
 *  Returns null for non-GitHub sources. */
export function githubRepoUrlFor(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const match = sourceUrl.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)(?:[/#?]|$)/i);
  return match ? match[1] : null;
}
