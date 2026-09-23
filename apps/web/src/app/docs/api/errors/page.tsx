import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "api/errors";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function ErrorsApiDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
