# Update Session Status Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the status dashboard to show "update" sessions (batch fetches for existing companies) alongside existing "onboard" sessions.

**Architecture:** Add a `type` field to SessionState in both the StatusHub DO and the dashboard. The fetch CLI command emits session lifecycle events in remote mode. The dashboard conditionally renders step badges and state columns based on session type.

**Tech Stack:** TypeScript, React, Cloudflare Durable Objects, Hono

---

### Task 1: Add `postStatusEvent` to API client

**Files:**
- Modify: `src/api/client.ts`

- [ ] **Step 1: Add the helper function**

At the end of `src/api/client.ts`, add:

```typescript
// ── Status events ──

export async function postStatusEvent(event: {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}): Promise<void> {
  await apiFetch("/api/status/event", {
    method: "POST",
    body: JSON.stringify(event),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/api/client.ts
git commit -m "feat: add postStatusEvent helper to API client"
```

---

### Task 2: Update SessionState and StatusHub DO

**Files:**
- Modify: `workers/api/src/status-hub.ts`

- [ ] **Step 1: Add `type` and update-specific fields to SessionState interface**

In `workers/api/src/status-hub.ts`, update the `SessionState` interface:

```typescript
interface SessionState {
  sessionId: string;
  company: string;
  type: "onboard" | "update";
  status: "running" | "complete" | "error";
  step?: string;
  // Onboard-specific
  sourcesFound?: number;
  sourcesValidated?: number;
  // Update-specific
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  // Shared
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt: number;
  error?: string;
}
```

- [ ] **Step 2: Update `handleEvent` for `session:start` to persist `type`**

In the `session:start` handler, add the `type` field:

```typescript
if (event.type === "session:start") {
  const session: SessionState = {
    sessionId: event.sessionId as string,
    company: event.company as string,
    type: (event.sessionType as SessionState["type"]) ?? "onboard",
    status: "running",
    startedAt: now,
    lastUpdatedAt: now,
  };
  await this.ctx.storage.put(`session:${session.sessionId}`, session);
}
```

Note: The event field is `sessionType` (not `type`) to avoid collision with the message `type` field.

- [ ] **Step 3: Update `handleEvent` for `session:progress` to persist update-specific fields**

In the `session:progress` handler, add the new fields alongside existing ones:

```typescript
} else if (event.type === "session:progress") {
  const existing = await this.ctx.storage.get<SessionState>(`session:${event.sessionId}`);
  if (existing) {
    existing.step = event.step as string;
    existing.sourcesFound = event.sourcesFound as number;
    existing.sourcesValidated = event.sourcesValidated as number;
    existing.currentAction = event.currentAction as string;
    // Update-specific fields
    if (event.totalSources !== undefined) existing.totalSources = event.totalSources as number;
    if (event.sourcesFetched !== undefined) existing.sourcesFetched = event.sourcesFetched as number;
    if (event.releasesFound !== undefined) existing.releasesFound = event.releasesFound as number;
    if (event.releasesInserted !== undefined) existing.releasesInserted = event.releasesInserted as number;
    existing.lastUpdatedAt = now;
    await this.ctx.storage.put(`session:${existing.sessionId}`, existing);
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/status-hub.ts
git commit -m "feat: add type and update-specific fields to StatusHub SessionState"
```

---

### Task 3: Update dashboard to render update sessions

**Files:**
- Modify: `web/src/app/status/dashboard.tsx`

- [ ] **Step 1: Update SessionState interface**

Add the same new fields to the dashboard's `SessionState`:

```typescript
interface SessionState {
  sessionId: string;
  company: string;
  type?: "onboard" | "update";  // optional for backward compat
  status: "running" | "complete" | "error";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt?: number;
  error?: string;
}
```

- [ ] **Step 2: Update `StepBadge` to handle update session steps**

```typescript
function StepBadge({ step, status, type }: { step?: string; status: string; type?: string }) {
  if (status === "complete") return <span className="text-green-600 text-xs">Complete</span>;
  if (status === "error") return <span className="text-red-500 text-xs">Error</span>;
  if (!step) return <span className="text-stone-400 text-xs">Starting...</span>;

  if (type === "update") {
    const color = step === "fetching" ? "text-blue-500" : "text-stone-500";
    return <span className={`text-xs capitalize ${color}`}>{step}</span>;
  }

  const color = step === "discovering" ? "text-amber-500" : step === "adding" ? "text-blue-500" : step === "validating" ? "text-green-500" : "text-stone-500";
  return <span className={`text-xs capitalize ${color}`}>{step}</span>;
}
```

- [ ] **Step 3: Update state column rendering in `SessionsTable`**

Replace the state column `<div>` in the session row button with logic that branches on type:

```typescript
<div className="text-sm text-stone-500">
  {session.status === "error" ? (
    <span className="text-red-500">{session.error?.slice(0, 40)}</span>
  ) : session.status === "complete" ? (
    (session.type ?? "onboard") === "update" ? (
      <span className="text-green-600">
        {session.sourcesFetched ?? 0} sources fetched, {session.releasesInserted ?? 0} new releases
      </span>
    ) : (
      <span className="text-green-600">{session.sourcesFound ?? 0} sources added</span>
    )
  ) : (
    (session.type ?? "onboard") === "update" ? (
      <span>
        {session.sourcesFetched ?? 0}/{session.totalSources ?? "?"} sources, {session.releasesInserted ?? 0} new releases
      </span>
    ) : (
      <span>
        {session.sourcesFound ?? 0} found, {session.sourcesValidated ?? 0} validated
      </span>
    )
  )}
</div>
```

- [ ] **Step 4: Pass `type` to `StepBadge`**

In the session row, update the StepBadge call:

```typescript
<StepBadge step={session.step} status={session.status} type={session.type} />
```

- [ ] **Step 5: Update empty state text**

Change the empty state message from:
```typescript
return <div className="text-sm text-stone-400 py-8 text-center">No discovery sessions yet.</div>;
```
to:
```typescript
return <div className="text-sm text-stone-400 py-8 text-center">No sessions yet.</div>;
```

- [ ] **Step 6: Commit**

```bash
git add web/src/app/status/dashboard.tsx
git commit -m "feat: render update sessions in status dashboard"
```

---

### Task 4: Emit session events from fetch command in remote mode

**Files:**
- Modify: `src/cli/commands/fetch.ts`

- [ ] **Step 1: Add imports**

At the top of `src/cli/commands/fetch.ts`, add:

```typescript
import { isRemoteMode } from "../../lib/mode.js";
import * as apiClient from "../../api/client.js";
import { eq } from "drizzle-orm";
import { organizations } from "../../db/schema.js";
```

Note: `eq` and `organizations` may not be imported yet — check existing imports and add only what's missing. The `eq` import from `drizzle-orm` is already present. The `organizations` import needs to be added to the existing `from "../../db/schema.js"` import.

- [ ] **Step 2: Add session lifecycle helpers inside the action handler**

After the `targetSources` resolution and before the `fetchOne` function, add:

```typescript
// ── Session tracking for remote mode ──
const sessionId = crypto.randomUUID();
let sessionCompany = "";
let sessionReleasesFound = 0;
let sessionReleasesInserted = 0;
let sessionSourcesFetched = 0;

async function startSession() {
  if (!isRemoteMode() || targetSources.length === 0) return;

  // Resolve company name from first source's orgId
  const orgId = targetSources[0].orgId;
  if (orgId) {
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    sessionCompany = org?.name ?? "";
  }
  if (!sessionCompany) {
    sessionCompany = targetSources.length === 1 ? targetSources[0].name : `${targetSources.length} sources`;
  }

  await apiClient.postStatusEvent({
    type: "session:start",
    sessionId,
    company: sessionCompany,
    sessionType: "update",
  }).catch(() => {});
}

async function progressSession() {
  if (!isRemoteMode()) return;
  await apiClient.postStatusEvent({
    type: "session:progress",
    sessionId,
    step: "fetching",
    totalSources: targetSources.length,
    sourcesFetched: sessionSourcesFetched,
    releasesFound: sessionReleasesFound,
    releasesInserted: sessionReleasesInserted,
  }).catch(() => {});
}

async function endSession(error?: string) {
  if (!isRemoteMode()) return;
  await apiClient.postStatusEvent({
    type: error ? "session:error" : "session:complete",
    sessionId,
    ...(error ? { error } : {}),
  }).catch(() => {});
}
```

- [ ] **Step 3: Call `startSession()` before the fetch loop**

Right before the `// Run with concurrency pool` comment, add:

```typescript
await startSession();
```

- [ ] **Step 4: Update `fetchOne` to track session progress**

In the `finally` block of `fetchOne` (which already has `active--; completed++; printProgress();`), add session tracking. Also accumulate results. After the line `fetchResults.push(...)` in the success path (around line 352), add:

```typescript
sessionReleasesFound += rawReleases.length;
sessionReleasesInserted += inserted;
```

In the `finally` block, after `printProgress()`, add:

```typescript
sessionSourcesFetched++;
progressSession();
```

- [ ] **Step 5: Call `endSession()` after the fetch loop**

After `process.removeListener("SIGINT", onSigint);`, add:

```typescript
const fetchErrors = fetchResults.filter((r) => r.error);
if (fetchErrors.length === fetchResults.length && fetchResults.length > 0) {
  await endSession(`All ${fetchResults.length} sources failed`);
} else {
  await endSession();
}
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/fetch.ts
git commit -m "feat: emit update session events from fetch command in remote mode"
```

---

### Task 5: Type-check and verify

- [ ] **Step 1: Run type checker**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Visual verification**

Open the status dashboard in the browser and confirm:
- Existing onboard sessions render correctly (backward compat)
- The empty state says "No sessions yet" instead of "No discovery sessions yet"

- [ ] **Step 3: Commit any fixes if needed**
