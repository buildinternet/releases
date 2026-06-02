/// <reference types="react/canary" />
import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import Script from "next/script";
import { ViewTransition } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { WebMcpProvider } from "@/components/webmcp-provider";
import { SearchHotkey } from "@/components/search-hotkey";
import { LightboxProvider } from "@/components/lightbox";
import { Footer } from "@/components/footer";
import "./globals.css";
import { apiBaseUrl } from "@/lib/env";

const PUBLIC_API_URL = apiBaseUrl() ?? "https://api.releases.sh";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "releases.sh — An agent-friendly API for product changelogs",
    template: "%s — releases.sh",
  },
  description:
    "The latest product releases, indexed for agents. Releases is a registry of release notes from across the web, queryable from your terminal, code, or MCP client.",
  metadataBase: new URL("https://releases.sh"),
  openGraph: {
    type: "website",
    siteName: "releases.sh",
    locale: "en_US",
    url: "https://releases.sh",
  },
  twitter: {
    card: "summary_large_image",
  },
};

// Minimal no-flash theme bootstrap: paint the correct root colors immediately,
// then let the client provider keep the class in sync after hydration.
const THEME_STYLE = `html{background-color:#fafaf9;color:#1c1917;color-scheme:light}html.dark{background-color:#0c0a09;color:#f5f5f4;color-scheme:dark}html.light{background-color:#fafaf9;color:#1c1917;color-scheme:light}@media (prefers-color-scheme: dark){html:not(.light):not(.dark){background-color:#0c0a09;color:#f5f5f4;color-scheme:dark}}body{background:transparent;color:inherit}`;
const THEME_SCRIPT = `(function(){try{var d=document.documentElement;var stored=localStorage.getItem("theme");var pref=stored==="light"||stored==="dark"?stored:d.dataset.themePreference||"system";var resolved=pref==="dark"||pref==="light"?pref:window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";d.dataset.themePreference=pref;d.classList.remove("light","dark");d.classList.add(resolved);d.style.colorScheme=resolved;}catch(e){}})();`;

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
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
        <style dangerouslySetInnerHTML={{ __html: THEME_STYLE }} />
      </head>
      <body className="font-sans bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 antialiased min-h-screen flex flex-col">
        <ThemeProvider>
          <SearchHotkey />
          <LightboxProvider>
            <ViewTransition default="auto">
              <main id="main" className="flex-1 flex flex-col">
                {children}
              </main>
            </ViewTransition>
          </LightboxProvider>
          <Footer />
        </ThemeProvider>
        <WebMcpProvider apiBaseUrl={PUBLIC_API_URL} />
      </body>
    </html>
  );
}
