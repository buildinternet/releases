import type { ReleaseLocationItem } from "@/lib/api";

/**
 * Stub-tier org body (#1947). A stub has no processed sources yet — this is the
 * primary content: "release info is published at these locations." Rendered in
 * place of the overview/activity panels when `org.status === "stub"`.
 */

type LocatorKind = "feed" | "github" | "appstore" | "file" | "url";

function resolveLocator(loc: ReleaseLocationItem): {
  kind: LocatorKind;
  href: string;
  label: string;
} {
  if (loc.feed) return { kind: "feed", href: loc.feed, label: "Feed" };
  if (loc.github)
    return { kind: "github", href: `https://github.com/${loc.github}`, label: "GitHub" };
  if (loc.appstore) return { kind: "appstore", href: loc.appstore, label: "App Store" };
  if (loc.file) return { kind: "file", href: loc.file, label: "Changelog file" };
  return { kind: "url", href: loc.url ?? "", label: "Page" };
}

function displayTarget(href: string): string {
  try {
    const u = new URL(href);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return href;
  }
}

export function StubLocations({
  orgName,
  locations,
}: {
  orgName: string;
  locations: ReleaseLocationItem[];
}) {
  return (
    <section className="py-4">
      <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface-2)] p-5">
        <h2 className="text-[15px] font-semibold text-[var(--fg)]">Not yet tracked</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--fg-3)]">
          {orgName} isn&apos;t tracked on releases.sh yet. Its release information is published at
          the {locations.length === 1 ? "location" : "locations"} below.
        </p>

        {locations.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-2">
            {locations.map((loc, i) => {
              const { kind, href, label } = resolveLocator(loc);
              return (
                <li key={`${kind}:${href}:${i}`}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener nofollow"
                    className="group flex items-center gap-3 rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 transition-colors hover:border-[var(--fg-4)]"
                  >
                    <span className="inline-flex shrink-0 items-center rounded-[6px] border border-[var(--line)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--fg-3)]">
                      {label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg-2)] group-hover:text-[var(--fg)]">
                      {loc.title ?? displayTarget(href)}
                    </span>
                    {loc.canonical && (
                      <span className="shrink-0 text-[11px] font-medium text-[var(--good)]">
                        canonical
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-[13px] text-[var(--fg-3)]">No locations declared yet.</p>
        )}
      </div>
    </section>
  );
}
