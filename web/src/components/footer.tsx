import Link from "next/link";

const GITHUB_REPO_URL = "https://github.com/buildinternet/releases-cli";

type FooterLink = { label: string; href: string; external?: boolean };
type FooterColumn = { title: string; links: FooterLink[] };

// Adding a future link is a one-line edit here — no JSX changes needed.
const COLUMNS: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { label: "Add your product", href: "/docs/listing" },
      { label: "Why", href: "/docs/why" },
      { label: "What's New", href: "/updates" },
      { label: "Live Updates", href: "/live" },
      { label: "Collections", href: "/collections" },
      { label: "Categories", href: "/categories" },
      { label: "Catalog", href: "/catalog" },
    ],
  },
  {
    title: "Agents",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "CLI", href: "/docs/installation" },
      { label: "MCP Server", href: "/docs/api/mcp" },
      { label: "REST API", href: "/docs/api/rest" },
      { label: "GitHub", href: GITHUB_REPO_URL, external: true },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Security", href: "/security" },
      { label: "Status", href: "https://status.releases.sh", external: true },
    ],
  },
];

const linkClass =
  "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 underline-offset-2 hover:underline transition-colors";

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
      <div className="max-w-5xl mx-auto px-6 py-10 grid grid-cols-2 gap-8 text-xs sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
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
          <p className="mt-4 text-[10px] leading-relaxed text-stone-400 dark:text-stone-600">
            Maintained by{" "}
            <a
              href="https://zachdunn.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-500 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-400 underline-offset-2 hover:underline"
            >
              Zach Dunn
            </a>{" "}
            /{" "}
            <a
              href="https://buildinternet.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-500 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-400 underline-offset-2 hover:underline"
            >
              Build Internet
            </a>
            .
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
    </footer>
  );
}
