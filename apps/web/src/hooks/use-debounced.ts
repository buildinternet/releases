"use client";

import { useEffect, useState } from "react";

/**
 * Returns `value` delayed by `delayMs`. A burst of updates within the window
 * collapses to a single trailing emission — used by inline filter inputs so
 * we fire one network request per typing pause instead of per keystroke.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, debounced, delayMs]);
  return debounced;
}
