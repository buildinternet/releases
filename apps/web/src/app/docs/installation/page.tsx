import { InstallTabs } from "@/components/install-tabs";
import { MarkdownDoc } from "@/components/markdown-doc";
import { McpInstallButtons } from "@/components/mcp-install-buttons";
import { docPageMetadata } from "@/lib/doc-metadata";

const SLUG = "installation";

export const generateMetadata = () => docPageMetadata(SLUG);

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
