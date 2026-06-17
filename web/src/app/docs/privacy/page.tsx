import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "privacy";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function PrivacyPage() {
  return <MarkdownDoc slug={SLUG} />;
}
