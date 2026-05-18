---
name: seeding-playbooks
description: Coordinate bulk playbook writing using parallel sub-agents — covers org discovery, prompt templates, model selection, batch dispatch, verification, and the parent-saves pattern for working around subagent permission limits. Currently wired up for Claude Code's Agent tool; the managed-agent fleet supports sub-agents too and the pattern can be adapted, but isn't wired up there yet.
---

# Seeding Playbooks

Coordinate bulk creation or enrichment of playbook agent notes across many orgs using parallel sub-agents.

## What a playbook is

**A playbook is a per-org skill for fetching that org's releases.** Same mental model as the global skills in this corpus (`parsing-changelogs`, `managing-sources`, etc.) — but scoped to one organization. It tells a future agent (managed or local) how to pull updates from _this_ org: extraction quirks, naming conventions, which sources are canonical, what to skip, where rollups hide.

Global skills teach general patterns; per-source `parseInstructions` teach source-specific hints; the playbook is the org-level layer between them. When agents fetch any of an org's sources, they should load that org's playbook into context alongside the global skills — the playbook overrides general rules with specific org behavior.

Write notes as instructions to an LLM, not as human documentation. Imperative voice ("Set version=null", "Parse `<h2>` as version boundaries"), concrete examples from real data, and only observations that change future fetch behavior.

**Currently a local-Claude-Code skill.** The dispatch pattern below uses Claude Code's Agent tool — that's what's actually wired up. Managed agents (discovery worker, Haiku worker) _can_ spawn sub-agents in principle, but the harness, prompt scaffolding, and rate-limit accounting for managed sub-agent dispatch in this repo haven't been built yet. If/when that gets wired up, the prompts and dispatch shape in this skill port directly.

## When to Use

- Batch-populating playbooks for orgs that have sources but no notes
- Re-running the verified workflow on existing playbooks to enrich them with data-grounded observations
- After a wave of new orgs are onboarded and need initial playbook scaffolding

## Step 1: Identify Targets

Find orgs that need playbooks. Run this to check coverage:

```bash
bun -e "
const orgs = JSON.parse(Bun.spawnSync(['bun', 'src/index.ts', 'admin', 'org', 'list', '--json'], { stderr: 'ignore' }).stdout.toString());
const active = orgs.filter(o => o.sourceCount > 0).sort((a,b) => b.releaseCount - a.releaseCount);
for (const org of active) {
  const playbook = JSON.parse(Bun.spawnSync(['releases', 'admin', 'playbook', org.slug, '--json'], { stderr: 'ignore' }).stdout.toString());
  const status = playbook.notes?.length > 100 ? 'has notes (' + playbook.notes.length + ' chars)' : 'NEEDS PLAYBOOK';
  console.log(org.slug.padEnd(25) + ' sources=' + String(org.sourceCount).padStart(2) + '  ' + status);
}
" 2>/dev/null
```

This produces a ranked list of orgs with their playbook status. Target orgs showing "NEEDS PLAYBOOK".

## Step 2: Gather Source Details

Before dispatching agents, collect source metadata for the target orgs. Each agent needs to know the org's sources, types, URLs, and product structure. Gather this in bulk:

```bash
for org in <slugs>; do
  echo "=== $org ==="
  bun src/index.ts admin org get "$org" --json 2>/dev/null | bun -e "
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

- Agent queries release data (`list <slug> --json`) and fetch logs (`admin source fetch-log <slug> --json`) before writing
- Good for: high-value orgs, scrape sources, orgs with known data quality issues
- Every claim is backed by observed data — version formats, actual cadence, content quality, fetch errors

### Model selection

| Model  | Cost/playbook                            | Best for                                                                                                                                 |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Opus   | ~$0.07 (compilation) / ~$0.13 (verified) | Top-10 orgs, complex source sets, first-time verified runs                                                                               |
| Sonnet | ~$0.01 / ~$0.03                          | Sweet spot for quality/cost. Most thorough output. Use for top-20 verified runs                                                          |
| Haiku  | ~$0.008 / ~$0.009                        | Bulk coverage (orgs 20+). Output is usable but may include filler. Cheapest even with higher token count (extra tokens are cached input) |

## Step 4: Dispatch Sub-Agents

Launch one agent per org, in parallel. Use batches of 10 to avoid overwhelming the system.

### Compilation prompt template

```
Write playbook agent notes for the org "{slug}" and save them using the CLI.

Playbooks are **skills for agents that will fetch from this org**. Write in imperative voice — tell the agent what to do, not what things are.

Notes have three headings: `### Fetch instructions`, `### Traps`, `### Coverage`.

**{Org name}'s sources:**
{list each source with: slug, type, url, and any notable metadata}

Products: {product list or "none"}

**Fetch instructions**: One paragraph per source in imperative voice. Tell the agent what to do ("Set version=null", "Parse <h2> as version boundaries", "No filtering needed"), what to expect (cadence, content quality), and when to skip.

**Traps**: Bullet list with **bolded trigger labels**. Only include things that would cause wasted work or bad data. Include "Don't re-discover" warnings for disabled sources.

**Coverage**: 2-3 sentences. Which sources are canonical, whether there are gaps.

Save by running:
releases admin playbook {slug} --notes-file - 2>/dev/null <<'NOTES'
YOUR NOTES HERE
NOTES

Verify with: releases admin playbook {slug} 2>/dev/null | tail -20
```

The playbook header regenerates automatically after any source create/update/delete, and the `--notes-file` PATCH seeds a fresh header on first write — no separate regenerate step needed.

### Verified prompt template

```
Write a **verified** playbook for the org "{slug}".
Unlike a basic playbook, you must do actual research first.

Playbooks are **skills for agents that will fetch from this org**. Write in imperative voice — tell the agent what to do, not what things are.

## Step 1: Gather data (run all of these)

bun src/index.ts admin org get {slug} --json 2>/dev/null
{for each source:}
bun src/index.ts list {source-slug} --json 2>/dev/null
bun src/index.ts admin source fetch-log {source-slug} --json 2>/dev/null

## Step 2: Analyze what you found

Before writing, answer these questions from the data:
- What version format does each source actually use? Cite examples.
- What's the real publish cadence? Count releases per month from dates.
- Are there fetch errors in the logs? What kind?
- Are there releases with missing dates, empty content, or data quality issues?
- **Is the source actually being fetched?** Compare `lastFetchedAt` to the cadence you just measured. An empty fetch-log + stale `lastFetchedAt` (older than ~3× the publish interval) means the cron is silently skipping this source — usually because the change-detector quirk is `unreliable`. Do not write "all releases ingested successfully" or "no errors" in that case; the source is stranded, not healthy.

## Step 3: Write skill-style notes grounded in data

Structure: `### Fetch instructions`, `### Traps`, `### Coverage`.

**Fetch instructions**: One paragraph per source in imperative voice. Tell the agent what to do ("Set version=null", "Parse <h2> as version boundaries"), what to expect (cadence, content quality), and when to skip. Cite version format examples from actual data.

**Traps**: Bullet list with **bolded trigger labels**. Only include things backed by evidence from fetch logs or release data. Include "Don't re-discover" warnings for disabled sources.

**Coverage**: 2-3 sentences. Which sources are canonical, whether there are gaps.

Every claim must cite observed data. If uncertain, say so explicitly.

## Step 4: Save

releases admin playbook {slug} --notes-file - 2>/dev/null <<'NOTES'
YOUR NOTES HERE
NOTES

Verify with: releases admin playbook {slug} 2>/dev/null | tail -20
```

### Dispatch pattern

```typescript
// Launch up to 10 agents in parallel per batch
Agent({
  description: "Write playbook: {slug}",
  model: "sonnet", // or "haiku" for bulk
  prompt: compiledPromptTemplate,
  run_in_background: true,
});
```

## Step 5: Handle the Parent-Saves Pattern

Sub-agents may be blocked from saving notes via Bash (heredoc permission issues). When this happens:

1. The agent completes analysis and reports its findings in the result
2. The parent agent (you) saves the notes manually:

```bash
releases admin playbook {slug} --notes-file - 2>/dev/null <<'NOTES'
{paste notes from agent result}
NOTES
```

This is a known limitation of subagent permissions. Plan for it — check each agent's result and save manually if needed.

## Step 6: Verify Results

After all agents complete, verify coverage in bulk:

```bash
bun -e "
const orgs = [{target slugs}];
for (const org of orgs) {
  const proc = Bun.spawnSync(['bun', 'src/index.ts', 'admin', 'content', 'playbook', org, '--json'], { stderr: 'ignore' });
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
