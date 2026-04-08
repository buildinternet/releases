import Link from "next/link";
import { Header } from "@/components/header";

export default function NotFound() {
  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-md mx-auto px-6 pt-24 text-center">
        <div className="text-5xl font-bold tracking-tight text-stone-300 dark:text-stone-700 mb-4">404</div>
        <p className="text-[15px] text-stone-500 dark:text-stone-400 mb-6">
          This page doesn't exist or isn't available yet.
        </p>
        <Link
          href="/"
          className="inline-block text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 underline underline-offset-4"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
