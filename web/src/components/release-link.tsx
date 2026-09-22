import Link from "next/link";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { isExternalReleaseLink, type ReleaseLinkProps } from "@/lib/release-link";

type ReleaseLinkElementProps = Omit<
  ComponentPropsWithoutRef<"a">,
  "href" | "className" | "children"
>;

/**
 * Renders `linkProps` (from `releaseLinkProps()`) as an `<a>` when it points
 * upstream ({@link isExternalReleaseLink}), or `next/link`'s `<Link>`
 * otherwise — the ternary every release-link call site used to repeat
 * inline. No "use client", no hooks: safe in server and client components
 * alike. Extra props (ref, onClick, aria-*, …) forward to the rendered
 * element.
 */
export const ReleaseLink = forwardRef<
  HTMLAnchorElement,
  ReleaseLinkElementProps & {
    linkProps: ReleaseLinkProps;
    className?: string;
    children?: ReactNode;
  }
>(function ReleaseLink({ linkProps, className, children, ...rest }, ref) {
  return isExternalReleaseLink(linkProps) ? (
    <a ref={ref} {...rest} {...linkProps} className={className}>
      {children}
    </a>
  ) : (
    <Link ref={ref} {...rest} {...linkProps} className={className}>
      {children}
    </Link>
  );
});
