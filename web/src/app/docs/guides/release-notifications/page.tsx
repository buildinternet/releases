import { MarkdownDoc } from "@/components/markdown-doc";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "guides/release-notifications";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function ReleaseNotificationsGuide() {
  return <MarkdownDoc slug={SLUG} />;
}
