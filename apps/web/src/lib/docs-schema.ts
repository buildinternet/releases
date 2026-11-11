import { z } from "zod";

/**
 * Docs frontmatter beyond Fumadocs' `title` / `description`. One definition,
 * used both by the MDX compiler (`source.config.ts`) and by the disk reader in
 * `@/lib/docs` (llms.txt, `.md` exports, tests), which also validates with it.
 *
 * - `label`     shorter sidebar / llms.txt link text (defaults to `title`)
 * - `adminOnly` page only exists when admin docs are on (local dev)
 * - `og`        a custom Open Graph card, served at `/api/og/docs/<slug>`;
 *               pages without one use the shared site card
 */
export const docExtrasSchema = z.object({
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
});

export const docFrontmatterSchema = docExtrasSchema.extend({
  title: z.string(),
  description: z.string().optional(),
});

export type DocFrontmatter = z.infer<typeof docFrontmatterSchema>;
