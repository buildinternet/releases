import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "guides/changelog-rss-feed";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function ChangelogRssFeedGuide() {
  return <MarkdownDoc slug={SLUG} />;
}
