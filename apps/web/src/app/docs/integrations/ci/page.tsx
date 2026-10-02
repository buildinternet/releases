import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "integrations/ci";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function PublishFromAnyCiDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
