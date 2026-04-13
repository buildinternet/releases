import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "cli/browsing";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function BrowsingPage() {
  return <MarkdownDoc slug={SLUG} />;
}
