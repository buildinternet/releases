import { MarkdownDoc } from "@/components/markdown-doc";
import { SkillsInstall } from "@/components/skills-install";
import { loadDoc } from "@/lib/docs";

const SLUG = "cli/browsing";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

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
