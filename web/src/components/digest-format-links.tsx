/**
 * Compact export chips for digest pages. Mirrors the collection context-rail
 * export strip. Atom is aggregate-only (index feed), never a single-week doc.
 */
export function DigestFormatLinks({
  path,
  atomHref,
  className = "",
}: {
  /** HTML path for `.md` / `.json` suffixes. */
  path: string;
  /**
   * Atom feed URL. Defaults to `${path}.atom` (index). Week pages pass the
   * digests index feed so the chip never invents a single-item Atom.
   */
  atomHref?: string;
  className?: string;
}) {
  const links = [
    { ext: "json", href: `${path}.json` },
    { ext: "md", href: `${path}.md` },
    { ext: "atom", href: atomHref ?? `${path}.atom` },
  ] as const;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-3)]">
        Export
      </span>
      {links.map(({ ext, href }) => (
        <a
          key={ext}
          href={href}
          className="inline-flex items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2.5 py-[5px] font-mono text-[11.5px] text-[var(--fg-2)] transition-colors hover:text-[var(--fg)]"
        >
          .{ext}
        </a>
      ))}
    </div>
  );
}
