import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "index";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function DocsOverview() {
  return <MarkdownDoc slug={SLUG} />;
}
