import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "integrations/slack";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function SlackIntegrationDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
