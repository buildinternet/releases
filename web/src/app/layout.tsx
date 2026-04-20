import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import { WebMcpProvider } from "@/components/webmcp-provider";
import { Footer } from "@/components/footer";
import "./globals.css";

const PUBLIC_API_URL = process.env.RELEASED_API_URL ?? "https://api.releases.sh";

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
    "An agent-friendly API for product changelogs. A unified registry of product releases, available via CLI, API, or MCP.",
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
      <body className="font-sans bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 antialiased min-h-screen flex flex-col">
        <ThemeProvider>
          <div className="flex-1 flex flex-col">{children}</div>
          <Footer />
        </ThemeProvider>
        <WebMcpProvider apiBaseUrl={PUBLIC_API_URL} />
      </body>
    </html>
  );
}
