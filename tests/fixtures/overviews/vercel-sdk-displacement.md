Vercel's recent work spans SDK releases, AI Gateway expansion, and platform-level changes across deployments and caching.

**AI SDK beta added Voyage AI and stabilized telemetry.** `@ai-sdk/voyage@1.0.0-beta.0` shipped embedding and reranking support. `experimental_telemetry` graduated to stable. The same release window saw Turborepo migrate Vercel auth to standard OAuth/device flows and add graceful shutdown with pnpm v11 multi-document lockfile support.

**Next.js v16.3.0 canary opened with prefetch and `'use cache'` improvements.** `prefetchInlining` enabled by default, `unstable_io` flag removed, and `'use cache'` deduplication improved for concurrent invocations. The v16.2.4 stable patch fixed Turbopack on Windows ARM64 and a cell-recomputation loop.

**AI Gateway expanded model access.** GPT-5.5 and GPT-5.5 Pro, GPT Image 2 (2K-resolution image generation), DeepSeek V4 Pro and Flash, Kimi K2.6, Claude Opus 4.7, and Seedance 2.0 video generation all landed via the AI SDK.

**Platform behavior shifted in April.** Hobby plan deployment retention caps at 30 days starting April 29 (existing production deployments exempt). New projects honor upstream `Cache-Control` headers from external origins by default. `@vercel/fs-detectors@6.0.0` excluded configuration files from static deployments — a breaking change.

Vercel Flags also reached general availability — targeting rules, user segments, and environment controls available from the Dashboard, with a Flags SDK for Next.js / SvelteKit and an OpenFeature adapter for other frameworks.
