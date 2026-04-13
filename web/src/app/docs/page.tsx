import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "index";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function DocsOverview() {
  return <MarkdownDoc slug={SLUG} />;
}
