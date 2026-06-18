import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { PasskeysPanel } from "@/components/passkeys-panel";

export const metadata: Metadata = {
  title: "Security",
  description: "Manage passkeys for your releases.sh account.",
  alternates: { canonical: "/account/security" },
  robots: { index: false, follow: false },
};

export default function AccountSecurityPage() {
  return (
    <AccountSection
      title="Security"
      description="Sign in without a password using your device's biometrics, PIN, or a security key. Passkeys are phishing-resistant and never leave your device."
    >
      <PasskeysPanel />
    </AccountSection>
  );
}
