---
"@buildinternet/releases-core": minor
"@buildinternet/releases-api-types": minor
---

Ending an ownership claim (#2389). Core adds a `revoked` claim status and nullable `org_claims.revoked_at`, `revoked_by`, and `revoke_reason` columns. API types add `revoked` to `OrgClaimStatus`, an optional `revokedAt` on `OrgClaim`, and the admin shapes `AdminOrgClaim`, `ListOrgClaimsResponse`, and `RevokeOrgClaimBody`.
