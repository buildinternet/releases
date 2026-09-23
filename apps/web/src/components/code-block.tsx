"use client";

import { isValidElement, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

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
  return (
    <div className="relative">
      <pre {...props} className={cn(props.className, "pr-12")} />
      <CopyButton
        text={extractText(props.children)}
        className="absolute top-2 right-2 hover:bg-stone-200 dark:hover:bg-stone-800"
      />
    </div>
  );
}
