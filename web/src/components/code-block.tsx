"use client";

import { isValidElement, type ReactNode } from "react";
import { CopyIcon } from "@/components/copy-icon";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return "";
}

export function CodeBlock(props: React.ComponentPropsWithoutRef<"pre">) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="relative">
      <pre {...props} />
      <button
        type="button"
        onClick={() => copy(extractText(props.children))}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        className="absolute top-2 right-2 p-1.5 rounded-md text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors"
      >
        <CopyIcon copied={copied} size={14} />
      </button>
    </div>
  );
}
