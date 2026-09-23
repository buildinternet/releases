import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "api/webhooks";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function WebhooksApiDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
