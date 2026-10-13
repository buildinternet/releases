import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "methodology";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function MethodologyPage() {
  return <MarkdownDoc slug={SLUG} />;
}
