import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "integrations/discord";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function DiscordIntegrationDocsPage() {
  return <MarkdownDoc slug={SLUG} />;
}
