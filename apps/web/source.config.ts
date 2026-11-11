import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import rehypeSlug from "rehype-slug";
import { remarkPlugins } from "@releases/rendering/markdown-plugins";
import { docExtrasSchema } from "./src/lib/docs-schema";
import { rehypeShikiPlugin } from "./src/lib/shiki";

/**
 * Docs content: `src/content/docs/**\/*.mdx`, ordered by `src/content/docs/meta.json`.
 * Extra frontmatter fields are defined once in `src/lib/docs-schema.ts`.
 */
export const docs = defineDocs({
  dir: "src/content/docs",
  docs: {
    schema: pageSchema.extend(docExtrasSchema.shape),
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
