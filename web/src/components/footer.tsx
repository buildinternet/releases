import Link from "next/link";

// Primary project repo — the open-source backend monorepo. The CLI ships from
// its own repo (buildinternet/releases-cli), reachable from the docs.
const GITHUB_REPO_URL = "https://github.com/buildinternet/releases";

// Sibling tool in the Build Internet family — hosts agent-captured screenshots
// and recordings for embedding in GitHub PRs/issues. Linked from the footer
// family bar for cross-site discovery.
const UPLOADS_URL = "https://uploads.sh";

type FooterLink = { label: string; href: string; external?: boolean };
type FooterColumn = { title: string; links: FooterLink[] };

// Featured collections — the agent- and developer-facing slices people reach
// for most. Full list lives behind the "All collections" link. Slugs must
// match the collection records (see `list_collections`).
const FEATURED_COLLECTIONS: FooterLink[] = [
  { label: "Coding Agents", href: "/collections/coding-agents" },
  { label: "Frontier AI Labs", href: "/collections/frontier-ai-labs" },
  { label: "Frontend Frameworks", href: "/collections/frontend-frameworks" },
  { label: "Application Platforms", href: "/collections/application-platforms" },
  { label: "Serverless Postgres", href: "/collections/serverless-postgres" },
  { label: "Auth & Identity", href: "/collections/auth-identity" },
  { label: "All collections →", href: "/collections" },
];

// Adding a future link is a one-line edit here — no JSX changes needed.
const COLUMNS: FooterColumn[] = [
  {
    title: "Browse",
    links: [
      { label: "Catalog", href: "/catalog" },
      { label: "Categories", href: "/categories" },
      { label: "Collections", href: "/collections" },
      { label: "What's New", href: "/updates" },
      { label: "Live Updates", href: "/live" },
    ],
  },
  {
    title: "Collections",
    links: FEATURED_COLLECTIONS,
  },
  {
    title: "Docs",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "CLI", href: "/docs/installation" },
      { label: "MCP Server", href: "/docs/api/mcp" },
      { label: "REST API", href: "/docs/api/rest" },
      { label: "Webhooks", href: "/docs/api/webhooks" },
      { label: "Skills", href: "/docs/skills" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Add your product", href: "/docs/listing" },
      { label: "Why", href: "/docs/why" },
      { label: "GitHub", href: GITHUB_REPO_URL, external: true },
      { label: "Status", href: "https://status.releases.sh", external: true },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Security", href: "/security" },
    ],
  },
];

const linkClass =
  "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 underline-offset-2 hover:underline transition-colors";

const creditLinkClass =
  "text-stone-500 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-400 underline-offset-2 hover:underline";

function FooterLinkItem({ link }: { link: FooterLink }) {
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className={linkClass}>
      {link.label}
    </Link>
  );
}

export function Footer() {
  return (
    <footer
      className="border-t border-stone-200 dark:border-stone-800 mt-auto"
      style={{ viewTransitionName: "site-footer" }}
    >
      <div className="max-w-5xl mx-auto px-6 pt-10 pb-6 grid grid-cols-2 gap-8 text-xs sm:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
        <div className="col-span-2 sm:col-span-1">
          <div>
            <Link
              href="/"
              className="font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
            >
              releases.sh
            </Link>
          </div>
          <p className="mt-2 max-w-[30ch] text-stone-500 dark:text-stone-400">
            A registry of release notes from across the web.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
              {column.title}
            </div>
            <ul className="space-y-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  <FooterLinkItem link={link} />
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      {/* Family bar — maintainer credit + a quiet cross-link to the sibling
          Build Internet tool. rel omits "noreferrer" so uploads.sh sees the
          referral traffic. */}
      <div className="border-t border-stone-200 dark:border-stone-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex flex-col gap-2 text-[10px] leading-relaxed text-stone-400 dark:text-stone-600 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Maintained by{" "}
            <a
              href="https://zachdunn.com"
              target="_blank"
              rel="noopener noreferrer"
              className={creditLinkClass}
            >
              Zach Dunn
            </a>{" "}
            /{" "}
            <a
              href="https://buildinternet.com"
              target="_blank"
              rel="noopener noreferrer"
              className={creditLinkClass}
            >
              Build Internet
            </a>
            .
          </p>
          <p>
            Screenshots &amp; recordings for agent PRs —{" "}
            <a href={UPLOADS_URL} target="_blank" rel="noopener" className={creditLinkClass}>
              uploads.sh →
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
