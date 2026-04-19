import { Fragment } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import matter from "gray-matter";
import { loadDoc, stripAdminBlocks, keepAdminBlocks } from "@/lib/docs";
import { adminDocs } from "@/flags";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { CodeBlock } from "@/components/code-block";
import { CopyPageButton } from "@/components/copy-page-button";
import { detailMarkdownComponents } from "@/components/markdown-components";

const markdownComponents = {
  ...detailMarkdownComponents,
  pre: CodeBlock,
};

const SLOT_PATTERN = /<!--\s*slot:([a-z0-9-]+)\s*-->/gi;

type Segment = { type: "markdown"; content: string } | { type: "slot"; name: string };

function splitBySlots(content: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(SLOT_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ type: "markdown", content: content.slice(lastIndex, start) });
    }
    segments.push({ type: "slot", name: match[1] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ type: "markdown", content: content.slice(lastIndex) });
  }
  return segments;
}

export async function MarkdownDoc({
  slug,
  slots,
}: {
  slug: string;
  slots?: Record<string, React.ReactNode>;
}) {
  const doc = loadDoc(slug);
  const body = adminDocs ? keepAdminBlocks(doc.body) : stripAdminBlocks(doc.body);
  const copyMarkdown = adminDocs
    ? doc.public
    : (() => {
        const parsed = matter(doc.public);
        return matter.stringify(stripAdminBlocks(parsed.content).trimStart(), parsed.data);
      })();
  const segments = splitBySlots(body);
  return (
    <>
      <div className="not-prose mb-8 flex justify-end">
        <CopyPageButton markdown={copyMarkdown} slug={slug} />
      </div>
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.type === "markdown" ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeShikiPlugin]}
              components={markdownComponents}
            >
              {seg.content}
            </ReactMarkdown>
          ) : (
            (slots?.[seg.name] ?? null)
          )}
        </Fragment>
      ))}
    </>
  );
}
