import { MarkdownDoc } from "@/components/markdown-doc";
import { loadDoc } from "@/lib/docs";

const SLUG = "privacy";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function PrivacyPage() {
  return <MarkdownDoc slug={SLUG} />;
}
