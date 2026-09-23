import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "listing";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function ListingPage() {
  return <MarkdownDoc slug={SLUG} />;
}
