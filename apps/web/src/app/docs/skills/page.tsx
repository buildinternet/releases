import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "skills";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function SkillsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
