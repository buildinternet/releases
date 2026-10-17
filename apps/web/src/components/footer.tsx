import Link from "next/link";

// Primary project repo — the open-source monorepo; the CLI ships from apps/cli.
const GITHUB_REPO_URL = "https://github.com/buildinternet/releases";

// Sibling tools in the Build Internet family. `referral` keeps the referrer
// (rel="noopener" without noreferrer) so these sites see cross-site traffic.
const BUILDNOTES_URL = "https://buildnotes.releases.sh";
const UPLOADS_URL = "https://uploads.sh";

type FooterLink = {
  label: string;
  href: string;
  external?: boolean;
  /** Sibling site: omit `noreferrer` so the destination sees referral traffic. */
  referral?: boolean;
  /** Native tooltip. Set only when the visible label needs a short gloss. */
  title?: string;
};
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
    title: "Guides",
    links: [
      { label: "Find a Changelog", href: "/docs/guides/find-a-changelog" },
      { label: "Changelog to RSS", href: "/docs/guides/changelog-rss-feed" },
      { label: "Get Notified", href: "/docs/guides/release-notifications" },
    ],
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
      { label: "Pricing", href: "/pricing" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "More from Build Internet",
    links: [
      {
        label: "buildnotes",
        href: BUILDNOTES_URL,
        external: true,
        referral: true,
        title: "PR to blog post skill",
      },
      { label: "uploads.sh", href: UPLOADS_URL, external: true, referral: true },
    ],
  },
];

const linkClass =
  "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 underline-offset-2 hover:underline transition-colors";

function FooterLinkItem({ link }: { link: FooterLink }) {
  if (link.external) {
    return (
      <a
        href={link.href}
        target="_blank"
        rel={link.referral ? "noopener" : "noopener noreferrer"}
        title={link.title}
        className={linkClass}
      >
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} title={link.title} className={linkClass}>
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
      <div className="mx-auto max-w-5xl px-6 pt-10 pb-8 text-xs xl:max-w-7xl">
        {/* Brand row — full width so the nav grid below can wrap into as many
            rows as the viewport needs without competing with the tagline. */}
        <div className="mb-8">
          <Link
            href="/"
            className="font-medium text-stone-700 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
          >
            Release Notes Index
          </Link>
          <p className="mt-2 max-w-[30ch] text-stone-500 dark:text-stone-400">
            A registry of release notes from across the web.
          </p>
        </div>
        {/* Nav grid — 6 columns wrap evenly: 2-up on phones (3 rows), 3-up
            from `sm` (2 rows). One row from `xl`, once the footer is wide
            enough for the longest label to stay on one line. */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 xl:grid-cols-6 xl:gap-x-6">
          {COLUMNS.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-balance text-stone-400 dark:text-stone-500">
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
      </div>

      {/* Maintainer credit. Sibling tools live in the nav grid above. Same
          text size as the column links (`text-xs`); earlier 10px / stone-600
          dark was hard to read. */}
      <div className="border-t border-stone-200 dark:border-stone-800">
        <div className="mx-auto max-w-5xl px-6 py-4 text-xs leading-relaxed text-stone-500 dark:text-stone-400 xl:max-w-7xl">
          <p>
            Maintained by{" "}
            <a
              href="https://zachdunn.com"
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Zach Dunn
            </a>{" "}
            /{" "}
            <a
              href="https://buildinternet.com"
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              Build Internet
            </a>
            .
          </p>
        </div>
      </div>
    </footer>
  );
}
