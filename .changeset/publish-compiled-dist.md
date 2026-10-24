---
"@buildinternet/releases-core": minor
"@buildinternet/releases-api-types": minor
---

Publish compiled ES modules and type declarations (`dist/`) instead of TypeScript source, so both packages import cleanly in Node, Deno and any bundler, not only in Bun or TypeScript-aware toolchains. Import paths are unchanged.
