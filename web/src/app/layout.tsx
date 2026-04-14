import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "releases.sh — A unified API for product changelogs",
    template: "%s — releases.sh",
  },
  description: "A unified, agent-readable index of product changelogs. Query release notes from any product via CLI, API, or MCP — one consistent shape, no scraping.",
  metadataBase: new URL("https://releases.sh"),
  openGraph: {
    type: "website",
    siteName: "releases.sh",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
  },
};

// Minimal no-flash theme bootstrap: paint the correct root colors immediately,
// then let the client provider keep the class in sync after hydration.
const THEME_STYLE = `html{background-color:#fafaf9;color:#1c1917;color-scheme:light}html.dark{background-color:#0c0a09;color:#f5f5f4;color-scheme:dark}html.light{background-color:#fafaf9;color:#1c1917;color-scheme:light}@media (prefers-color-scheme: dark){html:not(.light):not(.dark){background-color:#0c0a09;color:#f5f5f4;color-scheme:dark}}body{background:transparent;color:inherit}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const themeCookie = (await cookies()).get("theme")?.value;
  const initialTheme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : "system";
  const htmlClassName = [jetbrainsMono.variable, initialTheme === "system" ? null : initialTheme]
    .filter(Boolean)
    .join(" ");

  return (
    <html
      lang="en"
      className={htmlClassName}
      data-theme-preference={initialTheme}
      style={initialTheme === "system" ? undefined : { colorScheme: initialTheme }}
      suppressHydrationWarning
    >
      <head>
        <style dangerouslySetInnerHTML={{ __html: THEME_STYLE }} />
      </head>
      <body className="font-sans bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
