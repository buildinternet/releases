"use client";

import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

type CopyButtonProps = Omit<ComponentPropsWithoutRef<"button">, "type" | "onClick" | "children"> & {
  /** Text copied to the clipboard on click. */
  text: string;
  /** Fires after the copy, in addition to the built-in "Copied" state. */
  onCopy?: () => void;
};

/**
 * Shared click-to-copy affordance: a fixed 28px (h-7 w-7) square hit target
 * housing a 14px `CopyIcon` that cross-fades to a check on copy. Wraps
 * `useCopyToClipboard` internally, so it's self-contained — pass a ref to
 * trigger it programmatically from a surrounding whole-block click handler.
 */
const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(function CopyButton(
  { text, onCopy, className, "aria-label": ariaLabel = "Copy to clipboard", ...props },
  ref,
) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <button
      ref={ref}
      type="button"
      data-slot="copy-button"
      onClick={(e) => {
        // Stops a click from re-triggering a surrounding whole-block copy
        // handler (e.g. install-tabs.tsx) that delegates to this button via
        // a ref — without this, clicking the button directly double-fires.
        e.stopPropagation();
        copy(text);
        onCopy?.();
      }}
      aria-label={copied ? "Copied" : ariaLabel}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-stone-400 outline-none transition-colors hover:text-stone-700 focus-visible:ring-2 focus-visible:ring-stone-400 dark:text-stone-500 dark:hover:text-stone-200 dark:focus-visible:ring-stone-600",
        className,
      )}
      {...props}
    >
      <CopyIcon copied={copied} size={14} />
    </button>
  );
});

export { CopyButton };
