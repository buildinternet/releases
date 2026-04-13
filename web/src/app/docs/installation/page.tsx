import { InstallTabs } from "@/components/install-tabs";
import { MarkdownDoc } from "@/components/markdown-doc";
import { McpInstallButtons } from "@/components/mcp-install-buttons";
import { loadDoc } from "@/lib/docs";

const SLUG = "installation";

export function generateMetadata() {
  return { title: loadDoc(SLUG).frontmatter.title };
}

export default function InstallationPage() {
  return (
    <MarkdownDoc
      slug={SLUG}
      slots={{
        "install-tabs": (
          <div className="not-prose my-8">
            <InstallTabs />
          </div>
        ),
        "mcp-install-buttons": <McpInstallButtons />,
      }}
    />
  );
}
