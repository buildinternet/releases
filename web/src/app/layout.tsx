import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import "./globals.css";

export const metadata: Metadata = {
  title: "releases.sh",
  description: "Release notes, indexed. Track changelogs across the tools and libraries you depend on.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 antialiased" style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
