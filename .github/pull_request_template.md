## Summary

<!-- What does this change and why? Link the motivating issue. -->

Closes #

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat(api): ...`, lowercase subject — see [CONTRIBUTING.md](../CONTRIBUTING.md#pull-requests))
- [ ] `bun run check` passes
- [ ] `bun test` passes
- [ ] Schema changes: paired Drizzle migration under `workers/api/migrations/` (schema source of truth is `packages/core/`)
- [ ] Wire-protocol changes land in `packages/api-types/` first and are additive
- [ ] Docs updated if behavior changed

<!-- Note: workers auto-deploy from main on merge — every PR ships to production when it lands. -->
