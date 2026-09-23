"use client";

import { usePathname } from "next/navigation";
import { HeaderTypeahead } from "./header-typeahead";
import { SearchTrigger } from "./search-trigger";

/**
 * Header search slot. On most pages the lg+ field is a typeahead that stays
 * put while you type. On `/search` that field is replaced by the compact
 * trigger so the page box is the only editable input — two competing boxes
 * was the old first-keystroke-redirect bug.
 */
export function HeaderSearch() {
  const pathname = usePathname();
  const onSearchPage = pathname === "/search";

  if (onSearchPage) {
    return <SearchTrigger className="hidden lg:flex w-fit" />;
  }

  return (
    <>
      <HeaderTypeahead className="hidden lg:block w-full max-w-[420px]" />
      <SearchTrigger className="hidden sm:flex lg:hidden w-fit" />
    </>
  );
}
