import type { ReactNode } from "react";

/**
 * Shared replay controls: icon buttons whose tooltip also shows on focus.
 * The button carries `aria-label`; the tooltip is decorative.
 */

/** Hover/focus tooltip for an icon button. Decorative: the button has `aria-label`. */
export function Tip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--fg)] px-2 py-1.5 font-sans text-[12px] font-medium leading-none text-[var(--page)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {children}
    </span>
  );
}

export function IconButton({
  label,
  tip = label,
  onClick,
  text,
  children,
}: {
  label: string;
  tip?: string;
  onClick: () => void;
  /** Short text in place of an icon (the speed toggle). */
  text?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="group relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--fg-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
      {text ? (
        <span className="font-mono text-[12px] font-medium">{text}</span>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {children}
        </svg>
      )}
      <Tip>{tip}</Tip>
    </button>
  );
}

/** Circular-arrow restart glyph, for use inside {@link IconButton}. */
export function RestartIcon() {
  return (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>
  );
}
