---
title: "Errors"
description: "The standardized error envelope, error types, and common error codes returned by the REST API."
adminOnly: false
---

# Errors

Every non-2xx response uses one JSON shape:

```json
{
  "error": {
    "code": "not_found",
    "type": "not_found",
    "message": "Organization not found",
    "details": {}
  }
}
```

- **`type`** — a coarse category from a fixed set. It determines the HTTP status, so it's the safe field to switch on.
- **`code`** — a more specific, stable machine string. Never reworded once shipped, but open-ended: treat an unrecognized code by falling back to its `type` (or the HTTP status).
- **`message`** — human-readable, may change between releases. Don't parse it.
- **`details`** — optional structured context carried by a few codes (e.g. setup steps for `database_not_initialized`). Absent otherwise.

The HTTP status is authoritative and always agrees with `type`.

## Error types

| `type`               | HTTP | Meaning                                                       |
| -------------------- | ---- | ------------------------------------------------------------- |
| `validation`         | 400  | The request was malformed or failed a field/shape check.      |
| `unauthorized`       | 401  | Missing or invalid credentials.                               |
| `forbidden`          | 403  | Authenticated, but not allowed.                               |
| `insufficient_scope` | 403  | The token is valid but lacks the required scope.              |
| `not_found`          | 404  | No matching resource.                                         |
| `conflict`           | 409  | The request conflicts with existing state (e.g. a duplicate). |
| `rate_limited`       | 429  | Too many requests — retry after a short wait.                 |
| `upstream`           | 502  | A dependency the API called failed.                           |
| `unavailable`        | 503  | The endpoint is temporarily unavailable.                      |
| `internal`           | 500  | An unexpected server error.                                   |

## Common codes

`code` is more specific than `type`. The ones you'll see most often:

| `code`                | `type`               | When                                           |
| --------------------- | -------------------- | ---------------------------------------------- |
| `validation_failed`   | `validation`         | A request body failed schema validation.       |
| `bad_request`         | `validation`         | A business rule rejected the request.          |
| `invalid_json`        | `validation`         | The body wasn't valid JSON.                    |
| `payload_too_large`   | `validation`         | The request body exceeded the size cap.        |
| `unauthorized`        | `unauthorized`       | Sign-in or a valid token is required.          |
| `forbidden`           | `forbidden`          | The caller isn't permitted to do this.         |
| `insufficient_scope`  | `insufficient_scope` | The token lacks the scope this endpoint needs. |
| `not_found`           | `not_found`          | The resource doesn't exist.                    |
| `conflict`            | `conflict`           | A uniqueness or state conflict.                |
| `rate_limited`        | `rate_limited`       | The rate limit was hit; honor `Retry-After`.   |
| `service_unavailable` | `unavailable`        | The endpoint is disabled or temporarily down.  |

This isn't the full set — new codes can appear over time, so branch on `type` (or the HTTP status) and treat `code` as an optional refinement. The exhaustive list lives in the [OpenAPI spec](https://api.releases.sh/v1/openapi.json).

## Related

- [REST API](/docs/api/rest) — conventions, authentication, pagination.
- [Interactive reference](https://api.releases.sh/v1/docs) — every endpoint's request/response shapes.
