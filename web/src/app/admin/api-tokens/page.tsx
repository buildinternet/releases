import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { isAdminViewer } from "@/lib/server-session";
import { listMyTokensAction } from "@/app/actions/api-tokens";
import { TokensAdmin } from "./tokens-admin";

export const metadata: Metadata = { title: "API Tokens" };

export default async function ApiTokensPage() {
  if (!(await isAdminViewer())) notFound();

  const result = await listMyTokensAction();
  const initialTokens = result.ok ? result.tokens : [];
  const initialError = result.ok ? null : result.error;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
            API Tokens
          </h1>
        </div>
        <TokensAdmin initialTokens={initialTokens} initialError={initialError} />
      </div>
    </div>
  );
}
