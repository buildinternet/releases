import type { Metadata } from "next";
import { Header } from "@/components/header";
import { LiveStream } from "./live-stream";

export const metadata: Metadata = {
  title: "Live",
  robots: { index: false, follow: false },
};

export default function LivePage() {
  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-3xl mx-auto px-6 pt-8 pb-12">
        <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-4">
          Live releases
        </h1>
        <LiveStream apiUrl={apiUrl} />
      </div>
    </div>
  );
}
