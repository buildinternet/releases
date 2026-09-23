export function tabButtonClass(active: boolean): string {
  return `pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
    active
      ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
      : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
  }`;
}
