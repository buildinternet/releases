import ReactMarkdown from "react-markdown";
import { remarkPlugins } from "@/lib/markdown-plugins";
import rehypeSlug from "rehype-slug";
import { loadPage, pageMarkdown } from "@/lib/docs";
import { rehypeShikiPlugin } from "@/lib/shiki";
import { CodeBlock } from "@/components/code-block";
import { CopyPageButton } from "@/components/copy-page-button";
import { docMarkdownComponents } from "@/components/markdown-components";

const markdownComponents = {
  ...docMarkdownComponents,
  pre: CodeBlock,
};

/**
 * Renders a static markdown page from `src/content/pages/` (privacy, terms, …)
 * with the docs typography and a Copy page button. Docs pages under `/docs`
 * are MDX and render through `app/docs/[[...slug]]` instead.
 */
export function MarkdownDoc({ slug, viewHref }: { slug: string; viewHref: string }) {
  const doc = loadPage(slug);
  return (
    <>
      <div className="not-prose mb-8 flex justify-end">
        <CopyPageButton markdown={pageMarkdown(doc)} slug={slug} viewHref={viewHref} />
      </div>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeSlug, rehypeShikiPlugin]}
        components={markdownComponents}
      >
        {doc.body}
      </ReactMarkdown>
    </>
  );
}
