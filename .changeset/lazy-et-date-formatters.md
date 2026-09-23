---
"@buildinternet/releases-core": patch
---

`etDayKey` and the other Eastern-Time helpers in `dates` build their `Intl.DateTimeFormat` instances on first use instead of at import. Output is unchanged; importing the module no longer loads ICU time-zone data.
