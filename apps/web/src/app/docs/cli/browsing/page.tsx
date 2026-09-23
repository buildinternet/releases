import { MarkdownDoc } from "@/components/markdown-doc";
import { SkillsInstall } from "@/components/skills-install";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "cli/browsing";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function BrowsingPage() {
  return (
    <MarkdownDoc
      slug={SLUG}
      slots={{
        "skills-install": <SkillsInstall />,
      }}
    />
  );
}
