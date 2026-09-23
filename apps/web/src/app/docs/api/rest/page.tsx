import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "api/rest";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function RestApiDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
