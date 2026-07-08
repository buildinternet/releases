# Modeling products without over-fragmenting

The single most common mistake when authoring a `releases.json` is turning a company's
**marketing structure** into a pile of product entries. The registry groups by **where
releases are published**, so the only question that matters for each candidate product is:

> Does it have its own release location (repo / feed / changelog page / App Store listing)
> that differs from the company changelog?

If the answer is no, it does not belong in `products[]`.

---

## Anti-pattern 1 — a product per marketing capability

A site markets one platform as many "capabilities" or "solutions". An agent faithfully
mirrors the nav into products, and every one points at the **same** changelog:

```jsonc
// DON'T — eight products, one changelog, zero added information
{
  "version": 2,
  "name": "Amplitude",
  "releases": [{ "url": "https://amplitude.com/releases", "feed": "https://amplitude.com/releases/feed.xml", "canonical": true }],
  "products": [
    { "name": "Product Analytics", "releases": [{ "url": "https://amplitude.com/releases", "canonical": true }] },
    { "name": "Session Replay",    "releases": [{ "url": "https://amplitude.com/releases", "canonical": true }] },
    { "name": "Experiment",        "releases": [{ "url": "https://amplitude.com/releases", "canonical": true }] },
    { "name": "Data",              "releases": [{ "url": "https://amplitude.com/releases", "canonical": true }] }
    // …four more, all identical
  ]
}
```

Every product's locator is the top-level changelog. In the registry these dedup back to one
source — the products carry no release information the top-level array didn't already have.

```jsonc
// DO — one company, one changelog
{
  "version": 2,
  "name": "Amplitude",
  "description": "Digital analytics platform.",
  "releases": [{ "url": "https://amplitude.com/releases", "feed": "https://amplitude.com/releases/feed.xml", "canonical": true }]
}
```

If a capability later gets its *own* feed or repo, add it as a product **then** — when it
has a distinct release location to point at.

---

## Anti-pattern 2 — a product per language SDK

A company publishes client libraries across languages. Each is a separate GitHub repo, so
an agent makes each a product:

```jsonc
// DON'T — one product per language
"products": [
  { "name": "TypeScript SDK", "releases": [{ "github": "acme/acme-typescript" }] },
  { "name": "Python SDK",     "releases": [{ "github": "acme/acme-python" }] },
  { "name": "Swift SDK",      "releases": [{ "github": "acme/acme-swift" }] },
  { "name": "Go SDK",         "releases": [{ "github": "acme/acme-go" }] }
]
```

These are one developer offering with several distribution targets, not four products.
Bundle the repos as locators under a single product and mark the primary one `canonical`:

```jsonc
// DO — one SDK product, many github locators
"products": [
  {
    "name": "API & SDKs",
    "description": "The Acme API and its official client libraries.",
    "docs": "https://acme.com/docs",
    "releases": [
      { "github": "acme/acme-typescript", "canonical": true },
      { "github": "acme/acme-python" },
      { "github": "acme/acme-swift" },
      { "github": "acme/acme-go" }
    ]
  }
]
```

A product allows at most 8 release locations. With more repos than that, list the most
active ones (or a monorepo) rather than spilling into extra products to fit them all.

---

## When separate products ARE correct

Each genuinely has its own, distinct release stream. Vercel is the reference shape — every
product publishes releases in its own place, so each is a real entry:

```jsonc
"products": [
  { "name": "Next.js",    "website": "https://nextjs.org",     "releases": [{ "github": "vercel/next.js",   "canonical": true }, { "url": "https://nextjs.org/blog" }] },
  { "name": "Turborepo",  "website": "https://turborepo.com",  "releases": [{ "github": "vercel/turborepo", "canonical": true }] },
  { "name": "AI SDK",     "website": "https://ai-sdk.dev",     "releases": [{ "github": "vercel/ai",        "canonical": true }] },
  { "name": "v0",         "website": "https://v0.app",         "releases": [{ "url": "https://v0.app/changelog", "canonical": true }] }
]
```

The distinguishing feature isn't that these are "big" products — it's that each has a
release location the others don't share.

---

## A quick self-check before you finish

- Do two or more products carry the **identical** `url`/`feed`? Collapse them — that content
  belongs in the top-level `releases[]`.
- Is there a product per programming language? Merge into one SDK product.
- Does every product entry have at least one locator the top-level array doesn't already
  cover? If not, you probably don't need `products[]` at all.
- Did you put `tags` (or any non-schema field) on a product? Products only accept
  `name`, `slug`, `kind`, `category`, `description`, `website`, `docs`, `support`, `social`,
  `archived`, `releases`. `tags` is an **org-level** field. This is a frequent validation
  failure — the validator will flag it, but avoid it up front.
