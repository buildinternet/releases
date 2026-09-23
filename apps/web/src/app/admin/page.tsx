import { permanentRedirect } from "next/navigation";
import { adminDefaultHref } from "@/lib/account-nav";

/** Bare `/admin` → first Admin panel (auth-gated by `admin/layout.tsx`). */
export default function AdminIndexPage() {
  permanentRedirect(adminDefaultHref());
}
