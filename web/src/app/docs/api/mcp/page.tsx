import { MarkdownDoc } from "@/components/markdown-doc";
import { McpInstallButtons } from "@/components/mcp-install-buttons";
import { SkillsInstall } from "@/components/skills-install";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "api/mcp";

export const generateMetadata = () => docPageMetadata(SLUG);

export default function McpPage() {
  return (
    <MarkdownDoc
      slug={SLUG}
      slots={{
        "mcp-install-buttons": <McpInstallButtons />,
        "skills-install": <SkillsInstall />,
      }}
    />
  );
}
