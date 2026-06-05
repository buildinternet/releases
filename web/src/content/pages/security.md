---
title: "Security"
description: "How to report security vulnerabilities in releases.sh."
---

# Security

If you've found a security issue in the releases.sh web app, API, CLI, or MCP server, we want to hear from you. Please email [security@releases.sh](mailto:security@releases.sh) with details.

We do not offer a bug bounty or paid reward program, and we have no plans to do so.

For issues in the open-source CLI, you're also welcome to open a pull request or issue directly at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli). If the issue is sensitive, please email instead.

## What to include

- The affected endpoint, page, or binary.
- Steps to reproduce and, if possible, a minimal proof of concept.
- The impact you observed or believe is possible.
- Your contact info if you want credit once the issue is fixed.

## Scope

In scope:

- `releases.sh` and its subdomains (`api.releases.sh`, `*.releases.sh`).
- Account and authentication features — sign-in, sessions, password reset, and API keys.
- The open-source CLI at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli).
- The remote MCP server.

Out of scope:

- Vulnerabilities in indexed third-party content — report those to the original publisher.
- Missing security headers or TLS configuration that doesn't lead to a concrete issue.
- Rate-limit bypass reports already covered by our public rate-limit policy.
- Volumetric attacks (DDoS, mass scraping, spam) — these are handled by our upstream provider; no report is needed.
- Automated scanner output without a working proof of concept.

## Safe harbor

We won't pursue legal action against researchers who make a good-faith effort to follow this policy: no data exfiltration beyond what's needed to demonstrate the issue, no disruption of the service, no access to other users' data, and reasonable time to fix before public disclosure.

## Also see

Our [security.txt](/.well-known/security.txt) ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)) lists the same contact in machine-readable form.

## Revision history

- **April 20, 2026** — Initial version published.
- **June 5, 2026** — Added account and authentication features to the in-scope list.
