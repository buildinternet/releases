"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function SearchHotkey() {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "k" && e.key !== "K") return;
      e.preventDefault();
      const input = document.querySelector<HTMLInputElement>(
        'input[name="q"]',
      );
      if (input) {
        input.focus();
        input.select();
      } else {
        router.push("/search");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return null;
}
