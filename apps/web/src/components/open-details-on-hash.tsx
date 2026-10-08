"use client";

import { useEffect } from "react";

/**
 * Opens the `<details id={id}>` whenever `#id` is targeted — a direct link,
 * back/forward, or an in-page anchor click — since browsers don't reliably
 * expand a collapsed `<details>` on fragment navigation. Clicks are caught
 * before navigation so the jump lands on the expanded block, and a second
 * click on the same anchor (no `hashchange`) still reopens it.
 */
export function OpenDetailsOnHash({ id }: { id: string }) {
  useEffect(() => {
    const open = () => {
      const el = document.getElementById(id);
      if (el instanceof HTMLDetailsElement) el.open = true;
    };
    const onHash = () => {
      if (window.location.hash !== `#${id}`) return;
      open();
      document.getElementById(id)?.scrollIntoView();
    };
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (link?.getAttribute("href") === `#${id}`) open();
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick, true);
    };
  }, [id]);
  return null;
}
