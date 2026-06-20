# Breaking-change classification rubric

The artifact is a `breaking` verdict (`major` | `minor` | `none` | `unknown`)
and an extracted `migrationNotes` string for a single software release. The
release body it was classified from is provided as context. The bar is
**precision first**: a false `major`/`minor` (crying wolf) is worse than a false
`unknown`, because a wrong "this breaks" makes an agent distrust the signal
entirely. Grade each criterion independently.

## Verdict levels (what each MUST mean)

- **major** — taking the upgrade WILL break a consumer who changes nothing:
  removals of public API/CLI/config, renamed/changed signatures, changed return
  shapes, dropped runtime/platform/dependency support, required config or data
  migrations, or a default-behavior reversal that changes output for existing
  users.
- **minor** — a break that affects only an edge case or a narrow surface, OR a
  deprecation that still works this release (announced/shimmed/warns) but is
  scheduled for removal. Most consumers upgrade with no change.
- **none** — no breaking changes: additive features, bug fixes, performance,
  docs that don't alter an existing contract. The common case.
- **unknown** — undeterminable from the body (too vague, marketing-only, no
  detail). The fail-open default; preferred over a guess.

## Criteria

1. **Verdict matches the body's evidence.** The level is supported by an
   explicit statement in the body, not inferred from the version number alone (a
   `2.0.0` is not automatically `major`).
2. **No false alarm (the precision criterion).** A release with no stated break
   is NOT classified `major` or `minor`. When the body is too vague to support
   any verdict, the answer is `unknown`, never an invented break.
3. **Severity is calibrated.** A hard removal / dropped-support / required
   migration reads `major`; a still-working deprecation or edge-case break reads
   `minor`. Neither is inflated nor deflated.
4. **Migration notes are present iff the body gives upgrade steps.** When the
   body has a Migration/Upgrading/Breaking section or concrete before→after
   instructions, `migrationNotes` distills them in 1–3 plain sentences. When the
   body states no upgrade steps (or there's no break), `migrationNotes` is null.
5. **Migration notes are faithful.** Every instruction in `migrationNotes` comes
   from the body; no invented steps, flags, versions, or commands.
6. **No format leakage.** `migrationNotes` carries no raw XML tags, markdown
   code fences, or echoed input labels ("Body:", "Title:").

## Scoring guidance

- Exact-verdict accuracy is the headline metric.
- Weight criterion 2 (false alarm) heaviest: a fixture whose true label is
  `none`/`unknown` but was classified `minor`/`major` is the most costly miss.
- A `major`/`minor` true label answered `unknown` is a recall miss — undesirable
  but acceptable; it never misleads, it just abstains.
