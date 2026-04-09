import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
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

// Minimal no-flash theme bootstrap: paint the correct root colors immediately,
// then let the client provider keep the class in sync after hydration.
const THEME_STYLE = `html{background-color:#fafaf9;color:#1c1917;color-scheme:light}html.dark{background-color:#0c0a09;color:#f5f5f4;color-scheme:dark}html.light{background-color:#fafaf9;color:#1c1917;color-scheme:light}@media (prefers-color-scheme: dark){html:not(.light):not(.dark){background-color:#0c0a09;color:#f5f5f4;color-scheme:dark}}body{background:transparent;color:inherit}`;

const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme');var r=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches)?'dark':'light';var c=document.documentElement.classList;c.remove('light','dark');c.add(r);document.documentElement.style.colorScheme=r}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: THEME_STYLE }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="font-sans bg-stone-50 dark:bg-stone-950 text-stone-900 dark:text-stone-100 antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
