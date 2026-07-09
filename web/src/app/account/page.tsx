import { redirect } from "next/navigation";
import { ACCOUNT_SETTINGS_HOME } from "@/lib/account-nav";

export default function AccountPage() {
  redirect(ACCOUNT_SETTINGS_HOME);
}
