import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { EmailPanel } from "@/components/email-panel";

export const metadata: Metadata = {
  title: "Email",
  description: "Change the email address on your releases.sh account.",
  alternates: { canonical: "/account/email" },
  robots: { index: false, follow: false },
};

export default function AccountEmailPage() {
  return (
    <AccountSection
      title="Email"
      description="Your email address is how you sign in and where account notifications go. Changing it sends a confirmation link to your current address — the change takes effect only after you click it."
    >
      <EmailPanel />
    </AccountSection>
  );
}
