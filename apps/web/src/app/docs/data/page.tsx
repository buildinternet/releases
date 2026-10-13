import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "data";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function DataPage() {
  return <MarkdownDoc slug={SLUG} />;
}
