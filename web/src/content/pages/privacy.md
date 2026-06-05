---
title: "Privacy Policy"
description: "How releases.sh handles data collected from the web, API, accounts, CLI, and MCP server."
effectiveDate: "June 5, 2026"
---

# Privacy Policy

_Effective June 5, 2026_

This page explains what data releases.sh collects when you use the web app, the public API, a releases.sh account, the [releases CLI](https://github.com/buildinternet/releases-cli), or the MCP server, and who we share it with. The project is run by [Build Internet](https://buildinternet.com).

## What we collect

### Web app

The site does not run analytics scripts and does not use third-party advertising trackers. If you create an account, we set a first-party session cookie scoped to `releases.sh` so you stay signed in; we do not set cookies for anonymous visitors.

### Accounts

You can create an account to manage API keys and other authenticated features. Accounts are optional — the public catalog, API, CLI, and MCP server all work without one. When you have an account, we store:

- **Identity** — your email address and a display name. If you sign in with email and password, we store a salted hash of your password, never the password itself. If you sign in with a third-party provider (where offered), we store the identifier and basic profile (name and avatar) that provider returns, plus the OAuth tokens needed to maintain the connection.
- **Sessions** — a session token and, for each session, the IP address and user agent it was created from, so you can stay signed in and we can detect suspicious activity. We may also record the time you were last active.
- **Email verification and sign-in links** — short-lived, single-use tokens (stored hashed) used to verify your address, reset your password, or sign in via a one-time link.
- **API keys** — for each key you create, a name, a non-secret prefix shown for identification, a hash of the key (we cannot recover the key itself), the scope you granted it, and usage counters used for metering and rate limiting.
- **Abuse-prevention counters** — IP-keyed counters used to rate-limit sign-in and other sensitive authentication endpoints.

We send account-related email (verification, password reset, and sign-in links) through Cloudflare's email-sending service. We do not use your email address for marketing.

### API request logs

Requests to the API are logged with basic metadata — IP address, user agent, request path, response status, and timing — for operational and abuse-prevention purposes. We use these logs to diagnose errors, detect abuse, and enforce rate limits. Request logs are retained for up to 30 days. We do not sell them or share them for any independent third-party use; they are processed only by the infrastructure providers that host and route the service (chiefly Cloudflare) for those operational purposes — see [Service providers](#service-providers) below.

### CLI and MCP telemetry

The open-source CLI and the local MCP stdio server send anonymous usage events — command name, version, OS, exit code, duration, and a random UUID — to the public API. Telemetry is documented in full, including an exhaustive list of what is _not_ collected, at [/docs/privacy](/docs/privacy). Telemetry events are retained for 90 days and then deleted. You can opt out at any time.

### Indexed content

releases.sh aggregates publicly available release notes, changelogs, and feeds. We do not collect personal data from publishers beyond what they have published on their own public pages. If you publish a changelog and want it removed from our index, see [Takedowns](#takedowns-and-content-removal) below.

## How we use data

- To operate the service and fetch updates from the sources we track.
- To create and maintain your account, authenticate you, and let you manage API keys.
- To send account-related email (verification, password reset, and sign-in links).
- To enforce rate limits and prevent abuse of the API, accounts, and MCP server.
- To understand aggregate usage patterns for the CLI and MCP.
- To respond to your questions and takedown requests.

We do not sell data. We do not use account data, request logs, or telemetry for advertising, and we do not build advertising or marketing profiles. Account data is used only to operate the features above. The CLI telemetry ID is a random UUID unlinked to any account, email, or machine identifier.

## Service providers

We use a small number of service providers to host and operate releases.sh. These providers receive request metadata as part of normal routing and logging.

- **Cloudflare** — hosts the API and supporting infrastructure, stores the database, and sends account-related email.
- **Vercel** — hosts the web frontend.
- **Better Auth** — the authentication system we run. Account data lives in our own database; Better Auth's hosted administration dashboard, which we use to manage accounts and monitor sessions, can read that account and session data.
- **Anthropic** — provides the AI models our indexing pipeline uses to parse and summarize public changelogs. These models receive only the public content we are indexing, never your account data, queries, or other personal data.

If you sign in with a third-party provider (where offered), that provider also processes your sign-in according to its own privacy policy.

## Security practices

We follow standard security practices for a service of this kind. Traffic is served over HTTPS, secrets and credentials are encrypted at rest, and access to production systems is limited to maintainers. Passwords are stored only as salted hashes, API keys are stored only as hashes (the full key is shown once at creation and cannot be recovered afterward), and email-verification, password-reset, and sign-in tokens are short-lived, single-use, and stored hashed. Sign-in and other sensitive authentication endpoints are rate-limited to deter brute-force attempts.

## Retention

- Account data (identity, API keys): kept while your account is active, and deleted when you delete your account or ask us to remove it.
- Sessions and verification/sign-in tokens: expire automatically and are pruned after they lapse.
- CLI and MCP telemetry: 90 days, then deleted.
- API request logs: up to 30 days.
- Indexed public content: retained indefinitely unless removed on request.

## Takedowns and content removal

If you are a publisher and want a source removed from our index, or if you believe content we've indexed infringes your rights, email [abuse@releases.sh](mailto:abuse@releases.sh) with:

- The source URL or releases.sh page you want removed.
- Your relationship to the content (publisher, rights holder, agent).
- A brief reason for the request.

We aim to acknowledge takedown requests within 3 business days. We honor reasonable requests to remove or suppress content even when we're not legally required to.

## Security

To report a security vulnerability, please email [security@releases.sh](mailto:security@releases.sh). See [/security](/security) for our disclosure policy.

## Your rights

If you have an account, you can review and update your identity details and revoke API keys from your account settings. To delete your account and the data tied to it, or to request a copy of that data, email [privacy@releases.sh](mailto:privacy@releases.sh) from the address on the account.

If you don't have an account, we hold very little data that could be tied to you. To delete a specific telemetry ID, or for any other data-related question, email [privacy@releases.sh](mailto:privacy@releases.sh) and include the ID from `~/.releases/telemetry-id`.

## Changes

We may update this policy as the service changes. Material changes will be announced in the project's GitHub repository and reflected in the effective date above.

## Contact

- Privacy questions — [privacy@releases.sh](mailto:privacy@releases.sh)
- Takedowns and abuse — [abuse@releases.sh](mailto:abuse@releases.sh)
- Security reports — [security@releases.sh](mailto:security@releases.sh)

## Revision history

- **April 20, 2026** — Initial version published.
- **June 5, 2026** — Updated to reflect user account features (accounts, sessions, and API keys).
