import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import rehypeShikiFromHighlighter from "@shikijs/rehype/core";
import githubLight from "@shikijs/themes/github-light";
import githubDarkDimmed from "@shikijs/themes/github-dark-dimmed";
import js from "@shikijs/langs/javascript";
import ts from "@shikijs/langs/typescript";
import bash from "@shikijs/langs/bash";
import json from "@shikijs/langs/json";
import yaml from "@shikijs/langs/yaml";
import jsx from "@shikijs/langs/jsx";
import tsx from "@shikijs/langs/tsx";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import md from "@shikijs/langs/markdown";

const globalKey = "__shiki_highlighter" as const;

function getHighlighter() {
  const cached = (globalThis as Record<string, unknown>)[globalKey];
  if (cached) return cached as ReturnType<typeof createHighlighterCoreSync>;

  const instance = createHighlighterCoreSync({
    themes: [githubLight, githubDarkDimmed],
    langs: [js, ts, bash, json, yaml, jsx, tsx, css, html, md],
    engine: createJavaScriptRegexEngine(),
  });

  (globalThis as Record<string, unknown>)[globalKey] = instance;
  return instance;
}

const highlighter = getHighlighter();

const themeOptions = {
  themes: {
    light: "github-light",
    dark: "github-dark-dimmed",
  },
} as const;

/**
 * Ready-to-use rehype plugin tuple for ReactMarkdown.
 * Usage: rehypePlugins={[rehypeShikiPlugin]}
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rehypeShikiPlugin: any = [rehypeShikiFromHighlighter, highlighter, themeOptions];
