import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "guides/find-a-changelog";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function FindAChangelogGuide() {
  return <MarkdownDoc slug={SLUG} />;
}
