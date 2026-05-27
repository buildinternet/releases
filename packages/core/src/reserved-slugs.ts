/**
 * Reserved slug words — protect against collisions with web routes, future
 * expansion namespaces, and security-sensitive paths.
 *
 * Two scopes:
 *   - root:   top-level slugs (orgs). These share the namespace with the
 *             web app's root routes (`/[orgSlug]`), so the list is strict.
 *   - nested: slugs under an org (products, sources). Only a narrow subset
 *             of verbs and reserved sub-paths applies.
 */

const ROOT_RESERVED = [
  // --- Existing Next.js app routes (web/src/app/*) ---
  "api",
  "docs",
  "release",
  "search",
  "source",
  "status",
  "sitemap",
  "robots",
  "favicon",
  "icon",
  "opengraph-image",
  "not-found",
  "layout",
  "page",

  // --- Auth / account ---
  "login",
  "logout",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "signout",
  "sign-out",
  "register",
  "auth",
  "oauth",
  "sso",
  "saml",
  "account",
  "accounts",
  "me",
  "my",
  "profile",
  "password",
  "forgot",
  "reset",
  "verify",
  "confirm",
  "invite",
  "invitation",
  "invitations",
  "session",
  "sessions",

  // --- Admin / system ---
  "admin",
  "administrator",
  "dashboard",
  "console",
  "internal",
  "staff",
  "root",
  "system",
  "sudo",
  "moderator",
  "owner",

  // --- Settings / preferences ---
  "settings",
  "setting",
  "preferences",
  "config",
  "configuration",
  "billing",
  "subscription",
  "subscriptions",
  "plan",
  "plans",
  "upgrade",
  "downgrade",
  "checkout",
  "cart",
  "invoice",
  "invoices",

  // --- Legal / info ---
  "about",
  "privacy",
  "terms",
  "tos",
  "legal",
  "licenses",
  "license",
  "contact",
  "help",
  "support",
  "faq",
  "pricing",
  "careers",
  "jobs",
  "team",
  "blog",
  "news",
  "press",
  "media",
  "company",
  "partners",

  // --- Entity plurals / future expansion namespaces ---
  "org",
  "orgs",
  "organization",
  "organizations",
  "product",
  "products",
  "sources",
  "releases",
  "changelog",
  "changelogs",
  "tag",
  "tags",
  "category",
  "categories",
  "user",
  "users",
  "feed",
  "feeds",
  "playbook",
  "playbooks",
  "overview",
  "overviews",
  "event",
  "events",
  "subscribe",
  "subscribers",
  "notifications",
  "notification",

  // --- HTTP / infra ---
  "v1",
  "v2",
  "v3",
  "v4",
  "graphql",
  "rpc",
  "rest",
  "ws",
  "wss",
  "sse",
  "stream",
  "streams",
  "webhook",
  "webhooks",
  "hook",
  "hooks",
  "health",
  "healthz",
  "readiness",
  "liveness",
  "ping",
  "pong",
  "metrics",
  "trace",
  "traces",
  "log",
  "logs",

  // --- Assets / well-known ---
  "static",
  "assets",
  "asset",
  "cdn",
  "public",
  "private",
  "well-known",
  ".well-known",
  "manifest",
  "browserconfig",
  "apple-touch-icon",
  "security",
  "security-txt",
  "humans",
  "humans-txt",
  "ads",
  "ads-txt",

  // --- CRUD verbs / generic routing ---
  "new",
  "edit",
  "create",
  "update",
  "delete",
  "remove",
  "list",
  "index",
  "home",
  "all",
  "any",
  "none",
  "null",
  "undefined",
  "true",
  "false",

  // --- Security-sensitive / environment ---
  "env",
  "secrets",
  "secret",
  "keys",
  "key",
  "token",
  "tokens",
  "credentials",
  "credential",
  "debug",
  "test",
  "tests",
  "dev",
  "development",
  "staging",
  "prod",
  "production",
  "preview",

  // --- MCP / agent surface ---
  "mcp",
  "agent",
  "agents",
  "tool",
  "tools",
  "skill",
  "skills",
  "prompt",
  "prompts",
  "model",
  "models",
  "ai",
  "llm",

  // --- Common catch-alls ---
  "www",
  "mail",
  "email",
  "ftp",
  "app",
  "apps",
  "web",
  "site",
  "sites",
  "error",
  "errors",
  "404",
  "500",
  "503",
] as const;

const NESTED_RESERVED = [
  "new",
  "edit",
  "create",
  "update",
  "delete",
  "remove",
  "settings",
  "api",
  "admin",
  "preview",
  "index",
  "list",
  "all",
  "null",
  "undefined",
  "webhook",
  "webhooks",
  "events",
  "stream",
  "opengraph-image",
  "sitemap",
  // Org sub-tabs at `/{org}/{slug}` — added in #875 when org tabs moved to
  // path segments. A source/product slug matching these would shadow the
  // route via Next.js static-over-dynamic precedence.
  "releases",
  "sources",
  // Source sub-tabs at `/{org}/{src}/{slug}` — added in #875.
  "highlights",
  "changelog",
  // Static second-segment routes that bare `/{org}/{slug}` = product introduces
  // (#1190). `product` is the redirect prefix; `playbook`/`fetch-log` are org
  // tabs; `products` is defensive. A product/source slug matching any would be
  // shadowed by the static route.
  "product",
  "products",
  "playbook",
  "fetch-log",
] as const;

export const RESERVED_ROOT_SLUGS: ReadonlySet<string> = new Set(ROOT_RESERVED);
export const RESERVED_NESTED_SLUGS: ReadonlySet<string> = new Set(NESTED_RESERVED);

export type ReservedScope = "root" | "nested";

/**
 * Returns true if `slug` is reserved for the given scope.
 *
 * `root` applies to orgs (they occupy the top-level `/[orgSlug]` namespace).
 * `nested` applies to products and sources (scoped under an org).
 *
 * Input is lower-cased before comparison. Empty strings are not reserved
 * (callers should validate non-emptiness separately).
 */
export function isReservedSlug(slug: string, scope: ReservedScope = "root"): boolean {
  if (!slug) return false;
  const normalized = slug.toLowerCase();
  const set = scope === "root" ? RESERVED_ROOT_SLUGS : RESERVED_NESTED_SLUGS;
  return set.has(normalized);
}
