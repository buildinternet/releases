import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "releases.sh",
  description: "Release notes, indexed. Track changelogs across the tools and libraries you depend on.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900 antialiased" style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
