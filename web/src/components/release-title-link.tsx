import Link from "next/link";
import type { ReactNode } from "react";
import { releaseLinkTarget, type ReleaseLinkInput } from "@/lib/release-link";
import { EXTERNAL_UGC_REL } from "@/lib/sanitize";

/**
 * Title link for a release row: upstream source URL when the release has a
 * referenceable one, `/release/<id>` as fallback, plain children when
 * neither exists (see release-link.ts for the rationale).
 */
export function ReleaseTitleLink({
  release,
  className = "hover:underline underline-offset-2",
  children,
}: {
  release: ReleaseLinkInput;
  className?: string;
  children: ReactNode;
}) {
  const target = releaseLinkTarget(release);
  if (!target) return children;
  return (
    <Link
      href={target.href}
      {...(target.external ? { target: "_blank", rel: EXTERNAL_UGC_REL } : {})}
      className={className}
    >
      {children}
    </Link>
  );
}
