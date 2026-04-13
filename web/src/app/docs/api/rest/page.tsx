import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "api/rest";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function RestApiPage() {
  return <MarkdownDoc slug={SLUG} />;
}
