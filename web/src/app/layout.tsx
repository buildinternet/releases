import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Released — Changelog Index",
    template: "%s — Released",
  },
  description: "Changelog index for developers. Track release notes across tools, frameworks, and services.",
  metadataBase: new URL("https://releases.sh"),
  openGraph: {
    type: "website",
    siteName: "Released",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="font-sans bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
