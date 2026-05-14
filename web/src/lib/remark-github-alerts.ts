import type { Root, Blockquote, Paragraph, Text, RootContent } from "mdast";

const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
type AlertType = (typeof ALERT_TYPES)[number];

const ALERT_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(\r?\n|$)/i;

/**
 * remark plugin for GitHub's alert/callout syntax — the bit of GitHub-flavored
 * Markdown that isn't in `remark-gfm`. Turns a blockquote like
 *
 *   > [!NOTE]
 *   > Useful information that users should know.
 *
 * into a div with `markdown-alert markdown-alert-note` classes plus a labeled
 * title paragraph (styling lives in globals.css).
 *
 * https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts
 */
export function remarkGithubAlerts() {
  return (tree: Root) => {
    walk(tree);
  };
}

function walk(node: { children?: RootContent[] } | RootContent): void {
  const children = (node as { children?: RootContent[] }).children;
  if (!children) return;
  for (const child of children) {
    if (child.type === "blockquote") transformAlert(child);
    walk(child);
  }
}

function transformAlert(node: Blockquote): void {
  const first = node.children[0];
  if (!first || first.type !== "paragraph") return;
  const firstChild = first.children[0];
  if (!firstChild || firstChild.type !== "text") return;

  const match = firstChild.value.match(ALERT_RE);
  if (!match) return;

  const type = match[1].toLowerCase() as AlertType;
  const stripped = firstChild.value.slice(match[0].length);
  firstChild.value = stripped;

  // If the marker consumed the only text in the paragraph, drop the empty
  // first child entirely so we don't render a leading blank line. The
  // paragraph itself may still hold soft-break + remaining siblings.
  if (!stripped && first.children.length === 1) {
    node.children.shift();
  } else if (!stripped && first.children.length > 1) {
    first.children.shift();
    // A soft-break left at the front looks like a blank line in the output.
    if (first.children[0]?.type === "break") first.children.shift();
  }

  const title: Paragraph = {
    type: "paragraph",
    data: {
      hName: "p",
      hProperties: { className: ["markdown-alert-title"] },
    },
    children: [{ type: "text", value: titleFor(type) } satisfies Text],
  };

  node.children.unshift(title);

  node.data = {
    ...node.data,
    hName: "div",
    hProperties: {
      className: ["markdown-alert", `markdown-alert-${type}`],
    },
  };
}

function titleFor(type: AlertType): string {
  return type[0].toUpperCase() + type.slice(1);
}
