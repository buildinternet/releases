---
"@buildinternet/releases-core": minor
"@buildinternet/releases-api-types": patch
---

Add `DEVICE_AUTH_PURPOSES`, `DeviceAuthPurpose`, and `isDeviceAuthPurpose` to `api-token`. The CLI sends the purpose as the device-code `scope` (`login`, `keys`, or `publish-tokens`) so the approval page can say what's being approved. API types: no shape changes; bumped to follow the core pin.
