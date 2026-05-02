import Link from "next/link";
import { toSlug } from "@buildinternet/releases-core/slug";
import type { SidebarSection } from "./sidebar";

interface TaxonomyChip {
  label: string;
  href: string;
}

interface TaxonomyChipsProps {
  items: TaxonomyChip[];
}

export function TaxonomyChips({ items }: TaxonomyChipsProps) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100"
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

export function taxonomySidebarSections({
  category,
  tags,
}: {
  category: string | null | undefined;
  tags: string[] | null | undefined;
}): SidebarSection[] {
  const items: SidebarSection["items"] = [];
  if (category) {
    items.push({
      label: "Category",
      value: <TaxonomyChips items={[{ label: category, href: `/categories/${category}` }]} />,
    });
  }
  if (tags && tags.length > 0) {
    items.push({
      label: "Tags",
      value: <TaxonomyChips items={tags.map((t) => ({ label: t, href: `/tags/${toSlug(t)}` }))} />,
    });
  }
  return items.length > 0 ? [{ items }] : [];
}
