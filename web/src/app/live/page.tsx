import type { Metadata } from "next";
import { Header } from "@/components/header";
import { LiveStream } from "./live-stream";

const TITLE = "Live releases";
const DESCRIPTION =
  "A live feed of product releases as they're fetched and indexed by releases.sh. Watch new changelog entries arrive in real time across every tracked source.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/live" },
  openGraph: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
    url: "/live",
  },
  twitter: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
  },
};

export default function LivePage() {
  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-3xl mx-auto px-6 pt-8 pb-12">
        <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2">
          {TITLE}
        </h1>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-6">
          A live feed of product releases as they&rsquo;re fetched and indexed across every tracked
          source.
        </p>
        <LiveStream apiUrl={apiUrl} />
      </div>
    </div>
  );
}
