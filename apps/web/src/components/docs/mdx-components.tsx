import type { ReactNode } from "react";
import type { MDXComponents } from "mdx/types";
import { adminDocs } from "@/flags";
import { CodeBlock } from "@/components/code-block";
import { InstallTabs } from "@/components/install-tabs";
import { docMarkdownComponents } from "@/components/markdown-components";
import { McpInstallButtons } from "@/components/mcp-install-buttons";
import { SkillsInstall } from "@/components/skills-install";
import { LatestCompare, SearchCompare } from "@/components/docs/examples-compare";

/** Content only shown when admin docs are on (local dev). Stripped from `.md` exports too. */
function AdminOnly({ children }: { children: ReactNode }) {
  return adminDocs ? <>{children}</> : null;
}

/**
 * Everything a docs `.mdx` file can use: the shared docs markdown overrides
 * (heading anchors, link rules, tables, code blocks) plus the components that
 * pages place directly, e.g. `<SkillsInstall />`.
 *
 * Adding a component here? Give it a plain-markdown fallback in
 * `COMPONENT_MARKDOWN_FALLBACKS` (`@/lib/docs`) if agents reading the `.md`
 * export should see its content; otherwise it's dropped from the markdown.
 */
export const docsMdxComponents: MDXComponents = {
  ...docMarkdownComponents,
  pre: CodeBlock,
  AdminOnly,
  InstallTabs: () => (
    <div className="not-prose my-8">
      <InstallTabs />
    </div>
  ),
  LatestCompare,
  McpInstallButtons,
  SearchCompare,
  SkillsInstall,
};
