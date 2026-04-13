import { MarkdownDoc } from "@/components/markdown-doc";
import { McpInstallButtons } from "@/components/mcp-install-buttons";
import { loadDoc } from "@/lib/docs";

const SLUG = "api/mcp";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function McpPage() {
  return (
    <MarkdownDoc
      slug={SLUG}
      slots={{
        "mcp-install-buttons": <McpInstallButtons />,
      }}
    />
  );
}
