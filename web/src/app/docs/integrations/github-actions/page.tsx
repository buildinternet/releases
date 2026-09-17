import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "integrations/github-actions";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function GitHubActionsIntegrationDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
