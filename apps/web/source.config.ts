import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import rehypeSlug from "rehype-slug";
import { z } from "zod";
import { remarkPlugins } from "@releases/rendering/markdown-plugins";
import { rehypeShikiPlugin } from "./src/lib/shiki";

/**
 * Docs content: `src/content/docs/**\/*.mdx`, ordered by `src/content/docs/meta.json`.
 *
 * Frontmatter beyond Fumadocs' `title`/`description`:
 * - `label`     shorter sidebar / llms.txt link text (defaults to `title`)
 * - `adminOnly` page only exists when admin docs are on (local dev)
 * - `og`        a custom Open Graph card for the page, served at `/api/og/docs/<slug>`;
 *               pages without one use the shared site card
 *
 * Keep this schema in sync with `DocFrontmatter` in `src/lib/docs.ts`, which reads the
 * same files without the MDX compiler (llms.txt, `.md` exports, tests).
 */
export const docs = defineDocs({
  dir: "src/content/docs",
  docs: {
    schema: pageSchema.extend({
      label: z.string().optional(),
      adminOnly: z.boolean().optional(),
      og: z
        .object({
          alt: z.string(),
          eyebrow: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          description: z.string().optional(),
        })
        .optional(),
    }),
    // Collection-level options replace Fumadocs' default plugin preset, so docs
    // render through the same remark/rehype stack as every other markdown surface
    // on the site (GitHub-style heading ids, alerts, gemoji, dual-theme Shiki).
    mdxOptions: {
      remarkPlugins,
      rehypePlugins: [rehypeSlug, rehypeShikiPlugin],
    },
  },
});

export default defineConfig();
