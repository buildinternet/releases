import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "why";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function WhyPage() {
  return <MarkdownDoc slug={SLUG} />;
}
