import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "cli/analysis";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function AnalysisPage() {
  return <MarkdownDoc slug={SLUG} />;
}
