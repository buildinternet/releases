---
name: seeding-guides
description: Coordinate bulk source guide writing using parallel sub-agents — covers org discovery, prompt templates, model selection, batch dispatch, verification, and the parent-saves pattern for working around subagent permission limits. Local-only (Claude Code CLI) — managed agents do not yet support spawning sub-agents.
---

# Seeding Source Guides

Coordinate bulk creation or enrichment of source guide agent notes across many orgs using parallel sub-agents.

**Local-only**: This skill requires Claude Code's Agent tool to dispatch sub-agents. Managed agents (discovery worker, Haiku worker) cannot spawn sub-agents — that capability is behind a private beta and not yet available. When sub-agent support ships for managed agents, this skill can be adapted into a managed session mode.

## When to Use

- Batch-populating guides for orgs that have sources but no notes
- Re-running the verified workflow on existing guides to enrich them with data-grounded observations
- After a wave of new orgs are onboarded and need initial guide scaffolding

## Step 1: Identify Targets

Find orgs that need guides. Run this to check coverage:

```bash
bun -e "
const orgs = JSON.parse(Bun.spawnSync(['bun', 'src/index.ts', 'org', 'list', '--json'], { stderr: 'ignore' }).stdout.toString());
const active = orgs.filter(o => o.sourceCount > 0).sort((a,b) => b.releaseCount - a.releaseCount);
for (const org of active) {
  const guide = JSON.parse(Bun.spawnSync(['bun', 'src/index.ts', 'knowledge', 'guide', org.slug, '--json'], { stderr: 'ignore' }).stdout.toString());
  const status = guide.notes?.length > 100 ? 'has notes (' + guide.notes.length + ' chars)' : 'NEEDS GUIDE';
  console.log(org.slug.padEnd(25) + ' sources=' + String(org.sourceCount).padStart(2) + '  ' + status);
}
" 2>/dev/null
```

This produces a ranked list of orgs with their guide status. Target orgs showing "NEEDS GUIDE".

## Step 2: Gather Source Details

Before dispatching agents, collect source metadata for the target orgs. Each agent needs to know the org's sources, types, URLs, and product structure. Gather this in bulk:

```bash
for org in <slugs>; do
  echo "=== $org ==="
  bun src/index.ts org show "$org" --json 2>/dev/null | bun -e "
    const d = JSON.parse(await Bun.stdin.text());
    const products = d.products?.map(p => p.name + ' (' + p.slug + ')').join(', ') || 'none';
    console.log('Products:', products);
    d.sources?.forEach(s => {
      const meta = s.metadata || {};
      const parts = [s.slug, 'url=' + s.url, 'type=' + s.type];
      if (meta.feedUrl) parts.push('feed=' + meta.feedUrl);
      if (s.fetchPriority !== 'normal') parts.push('priority=' + s.fetchPriority);
      if (meta.parseInstructions) parts.push('parseInstructions=YES');
      console.log('  ' + parts.join(' | '));
    });
  " 2>/dev/null
done
```

## Step 3: Choose Workflow and Model

### Compilation workflow (fast, metadata-only)
- Agent writes notes from source metadata without querying release data
- Good for: bulk scaffolding, low-priority orgs, initial coverage
- Notes are educated guesses — claims about page structure and cadence are inferred, not verified

### Verified workflow (thorough, data-grounded)
- Agent queries release data (`list <slug> --json`) and fetch logs (`fetch-log <slug> --json`) before writing
- Good for: high-value orgs, scrape sources, orgs with known data quality issues
- Every claim is backed by observed data — version formats, actual cadence, content quality, fetch errors

### Model selection

| Model | Cost/guide | Best for |
|-------|-----------|----------|
| Opus | ~$0.07 (compilation) / ~$0.13 (verified) | Top-10 orgs, complex source sets, first-time verified runs |
| Sonnet | ~$0.01 / ~$0.03 | Sweet spot for quality/cost. Most thorough output. Use for top-20 verified runs |
| Haiku | ~$0.008 / ~$0.009 | Bulk coverage (orgs 20+). Output is usable but may include filler. Cheapest even with higher token count (extra tokens are cached input) |

## Step 4: Dispatch Sub-Agents

Launch one agent per org, in parallel. Use batches of 10 to avoid overwhelming the system.

### Compilation prompt template

```
Write source guide agent notes for the org "{slug}" and save them using the CLI.

Source guides help agents understand how to fetch releases from each org's sources.
Notes have three headings: `### Extraction patterns`, `### Known quirks`, `### Source coverage`.

**{Org name}'s sources:**
{list each source with: slug, type, url, and any notable metadata}

Products: {product list or "none"}

Write one paragraph per source under Extraction patterns. Bullet points for Known quirks.
Narrative for Source coverage.

Save by running:
bun src/index.ts knowledge guide {slug} --regenerate 2>/dev/null
bun src/index.ts knowledge guide {slug} --notes "$(cat <<'NOTES'
YOUR NOTES HERE
NOTES
)" 2>/dev/null

Verify with: bun src/index.ts knowledge guide {slug} 2>/dev/null | tail -20
```

### Verified prompt template

```
Write a **verified** source guide for the org "{slug}".
Unlike a basic guide, you must do actual research first.

## Step 1: Gather data (run all of these)

bun src/index.ts org show {slug} --json 2>/dev/null
{for each source:}
bun src/index.ts list {source-slug} --json 2>/dev/null
bun src/index.ts fetch-log {source-slug} --json 2>/dev/null

## Step 2: Analyze what you found

Before writing, answer these questions from the data:
- What version format does each source actually use? Cite examples.
- What's the real publish cadence? Count releases per month from dates.
- Are there fetch errors in the logs? What kind?
- Are there releases with missing dates, empty content, or data quality issues?

## Step 3: Write notes grounded in data

Structure: `### Extraction patterns`, `### Known quirks`, `### Source coverage`.
Every claim must cite observed data. If uncertain, say so explicitly.

## Step 4: Save

bun src/index.ts knowledge guide {slug} --regenerate 2>/dev/null
bun src/index.ts knowledge guide {slug} --notes "$(cat <<'NOTES'
YOUR NOTES HERE
NOTES
)" 2>/dev/null

Verify with: bun src/index.ts knowledge guide {slug} 2>/dev/null | tail -20
```

### Dispatch pattern

```typescript
// Launch up to 10 agents in parallel per batch
Agent({
  description: "Write guide: {slug}",
  model: "sonnet",  // or "haiku" for bulk
  prompt: compiledPromptTemplate,
  run_in_background: true,
})
```

## Step 5: Handle the Parent-Saves Pattern

Sub-agents may be blocked from saving notes via Bash (heredoc permission issues). When this happens:

1. The agent completes analysis and reports its findings in the result
2. The parent agent (you) saves the notes manually:

```bash
bun src/index.ts knowledge guide {slug} --regenerate 2>/dev/null
bun src/index.ts knowledge guide {slug} --notes "$(cat <<'NOTES'
{paste notes from agent result}
NOTES
)" 2>/dev/null
```

This is a known limitation of subagent permissions. Plan for it — check each agent's result and save manually if needed.

## Step 6: Verify Results

After all agents complete, verify coverage in bulk:

```bash
bun -e "
const orgs = [{target slugs}];
for (const org of orgs) {
  const proc = Bun.spawnSync(['bun', 'src/index.ts', 'knowledge', 'guide', org, '--json'], { stderr: 'ignore' });
  try {
    const d = JSON.parse(proc.stdout.toString());
    const len = d.notes?.length ?? 0;
    console.log(org.padEnd(25) + (len > 100 ? 'OK (' + len + ' chars)' : 'MISSING'));
  } catch { console.log(org.padEnd(25) + 'ERROR'); }
}
" 2>/dev/null
```

**Important**: Do not pipe `bun | bun` in shell for-loops — stdin contention causes silent failures. Use `Bun.spawnSync` in a single process as shown above.

## Tracking Notes

When coordinating a batch run, keep notes on:

- **Failure modes**: Which agents failed to save? Was it permissions, timeouts, or bad output?
- **Data quality issues found**: Verified runs surface broken feeds, empty content, stale data. Collect these for follow-up fixes.
- **Model quality at this tier**: Did Haiku produce usable output or did it need manual cleanup?
- **Coverage gaps identified**: Agents often note missing sources — collect these as onboarding candidates.

Write findings to `.context/` for future reference.
