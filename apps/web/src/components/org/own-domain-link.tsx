"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClaimPanel } from "@/components/org/claim-panel";

/**
 * Quiet "Own this domain?" entry point for an already-tracked org (#2393). Stub
 * orgs get the full `ClaimPanel` inline on their page; a tracked org gets this
 * rail link, which opens the same flow in a dialog. The panel mounts only when
 * opened, so an org page view costs no claim/capability fetches.
 */
export function OwnDomainLink({
  orgSlug,
  domain,
  className,
}: {
  orgSlug: string;
  domain: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        Own {domain}?
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* Portaled out of the org page, so re-apply `org-surface` for the claim panel's tokens. */}
        <DialogContent className="org-surface sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Verify you own {domain}</DialogTitle>
            <DialogDescription>
              Verified owners can publish release notes to Releases Index directly, so new releases
              show up right away instead of waiting for our next check.
            </DialogDescription>
          </DialogHeader>
          {open && <ClaimPanel orgSlug={orgSlug} domain={domain} tracked />}
        </DialogContent>
      </Dialog>
    </>
  );
}
