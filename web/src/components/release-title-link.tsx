import Link from "next/link";
import type { ReactNode } from "react";
import { releaseLinkProps, type ReleaseLinkInput } from "@/lib/release-link";

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
  const linkProps = releaseLinkProps(release);
  if (!linkProps) return children;
  return (
    <Link {...linkProps} className={className}>
      {children}
    </Link>
  );
}
