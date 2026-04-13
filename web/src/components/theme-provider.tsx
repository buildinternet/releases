"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeCtx {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialTheme(): Theme {
  if (typeof document === "undefined") return "system";
  const theme = document.documentElement.dataset.themePreference;
  return theme === "light" || theme === "dark" ? theme : "system";
}

function getInitialResolvedTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  if (document.documentElement.classList.contains("dark")) return "dark";
  if (document.documentElement.classList.contains("light")) return "light";
  return getSystemTheme();
}

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);
  document.documentElement.style.colorScheme = resolved;
}

function syncThemeCookie(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.themePreference = theme;

  if (theme === "system") {
    document.cookie = "theme=; Max-Age=0; Path=/; SameSite=Lax";
    return;
  }

  document.cookie = `theme=${theme}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const [systemPreference, setSystemPreference] = useState<"light" | "dark">(getInitialResolvedTheme);
  const themeRef = useRef(theme);

  const resolved = theme === "system" ? systemPreference : theme;

  // Initialize from localStorage + system preference
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    const t = stored === "light" || stored === "dark" ? stored : "system";
    setThemeState(t);
    themeRef.current = t;
    setSystemPreference(getSystemTheme());
    syncThemeCookie(t);
  }, []);

  // Apply to DOM whenever resolved changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Stable matchMedia listener
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      if (themeRef.current === "system") {
        setSystemPreference(e.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    themeRef.current = t;
    if (t === "system") {
      setSystemPreference(getSystemTheme());
      localStorage.removeItem("theme");
    } else {
      localStorage.setItem("theme", t);
    }
    syncThemeCookie(t);
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}
