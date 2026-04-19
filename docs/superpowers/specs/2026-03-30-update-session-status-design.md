# Update Session Support on Status Dashboard

**Date**: 2026-03-30

## Problem

The status dashboard only tracks "onboard" (discovery) sessions. When fetching new releases for an existing company's sources, individual fetch results appear in the Fetch Log tab but there's no session-level view. The user has no way to see "updating Supabase — 2/6 sources done, 8 new releases so far."

## Design

### Approach

Add a `type` field to `SessionState` so the dashboard can render both onboard and update sessions in the same Sessions table, adapting the step badge, state column, and completion message based on type.

### SessionState Interface Changes

Add to the existing `SessionState` interface (in both `dashboard.tsx` and `status-hub.ts`):

```typescript
interface SessionState {
  sessionId: string;
  company: string;
  type: "onboard" | "update"; // NEW — defaults to "onboard"
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
  lastUpdatedAt?: number;
  error?: string;
}
```

### Dashboard Rendering by Type

**Step badge** (`StepBadge` component):

- Onboard: discovering | adding | validating | Complete | Error
- Update: fetching | Complete | Error

**State column (while running)**:

- Onboard: "3 found, 1 validated" (unchanged)
- Update: "2/6 sources, 8 new releases"

**State column (complete)**:

- Onboard: "6 sources added" (unchanged)
- Update: "6 sources fetched, 12 new releases"

**Empty state**: "No sessions yet" (was "No discovery sessions yet")

### Fetch Command Changes

In `src/cli/commands/fetch.ts`, when `isRemoteMode()` and fetching sources for a batch:

1. Before the batch: POST `session:start` with `type: "update"`, `company` set to org name (or source name for single-source fetches)
2. After each source completes: POST `session:progress` with incremented `sourcesFetched` and accumulated `releasesFound`/`releasesInserted`
3. When done: POST `session:complete` or `session:error`

### API Client Addition

Add `postStatusEvent(event)` to `src/api/client.ts` — a POST to `/api/status/event` that forwards the event to the StatusHub Durable Object.

### StatusHub Durable Object

No structural changes. The DO already stores and forwards arbitrary fields on SessionState. The `type` field flows through naturally. Default `type` to `"onboard"` for backward compatibility with sessions that don't have it set.

In `handleEvent` for `session:start`: persist `type` from the event payload (default `"onboard"`).
In `handleEvent` for `session:progress`: persist `totalSources`, `sourcesFetched`, `releasesFound`, `releasesInserted` alongside existing fields.

## Files to Modify

| File                               | Change                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `web/src/app/status/dashboard.tsx` | Add `type` to SessionState, update StepBadge and state rendering               |
| `workers/api/src/status-hub.ts`    | Add `type` to SessionState, persist update-specific fields in progress handler |
| `src/cli/commands/fetch.ts`        | Emit session start/progress/complete events in remote mode                     |
| `src/api/client.ts`                | Add `postStatusEvent()` helper                                                 |

## Backward Compatibility

Existing onboard sessions stored in the StatusHub DO won't have a `type` field. The dashboard defaults missing `type` to `"onboard"` so they render correctly.
