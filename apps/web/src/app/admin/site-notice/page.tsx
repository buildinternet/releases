import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { getSiteNoticeAdminAction } from "@/app/actions/site-notice";
import { navItem } from "@/lib/account-nav";
import { NoticeForm } from "./notice-form";

const item = navItem("admin-site-notice");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

export default async function SiteNoticeAdminPage() {
  const current = await getSiteNoticeAdminAction();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <NoticeForm current={current} />
    </SettingsSection>
  );
}
