import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "skills";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function SkillsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
