---
"@buildinternet/releases-core": patch
---

Add `actorManaged`, `actorNextAlarmAt`, and `actorLastAlarmAt` columns to the `sources` table and the `sourcesActive` / `sourcesVisible` views. They replace the `metadata.sourceActor` JSON mirror.
