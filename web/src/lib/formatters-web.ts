import matter from "gray-matter";
import type { OrgListItem, SourceListItem, Stats } from "@buildinternet/releases-api-types";
import { loadPage } from "@/lib/docs";

export function homeToMarkdown(args: {
  stats: Stats;
  orgs: OrgListItem[];
  independentSources: SourceListItem[];
  baseUrl: string;
}): string {
  const { frontmatter, body } = loadPage("home");

  const orgList =
    args.orgs
      .slice(0, 25)
      .map(
        (o) =>
          `- [${o.name}](${args.baseUrl}/${o.slug}) — ${o.sourceCount} source${o.sourceCount === 1 ? "" : "s"}, ${o.releaseCount.toLocaleString()} release${o.releaseCount === 1 ? "" : "s"}`,
      )
      .join("\n") || "_None yet._";

  const sourceList =
    args.independentSources
      .slice(0, 25)
      .map(
        (s) =>
          `- [${s.name}](${args.baseUrl}/source/${s.slug})${s.latestVersion ? ` — latest \`${s.latestVersion}\`` : ""}`,
      )
      .join("\n") || "_None yet._";

  const rendered = body
    .replace("{{stats.orgs}}", String(args.stats.orgs))
    .replace("{{stats.sources}}", String(args.stats.sources))
    .replace("{{stats.releases}}", args.stats.releases.toLocaleString())
    .replace("{{orgs}}", orgList)
    .replace("{{independentSources}}", sourceList);

  return matter.stringify(rendered.trimStart(), frontmatter);
}
