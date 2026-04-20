---
title: "Privacy Policy"
description: "How releases.sh handles data collected from the web, API, CLI, and MCP server."
effectiveDate: "April 20, 2026"
---

# Privacy Policy

_Effective April 20, 2026_

This page explains what data releases.sh collects when you use the web app, the public API, the [releases CLI](https://github.com/buildinternet/releases-cli), or the MCP server, and who we share it with. The project is run by [Build Internet](https://buildinternet.com).

## What we collect

### Web app

The site does not set cookies, does not run analytics scripts, and does not use third-party trackers.

### API request logs

Requests to the API are logged with basic metadata — IP address, user agent, request path, response status, and timing — for operational and abuse-prevention purposes. We use these logs to diagnose errors, detect abuse, and enforce rate limits. Request logs are retained for up to 30 days and are not shared with third parties.

### CLI and MCP telemetry

The open-source CLI and the local MCP stdio server send anonymous usage events — command name, version, OS, exit code, duration, and a random UUID — to the public API. Telemetry is documented in full, including an exhaustive list of what is _not_ collected, at [/docs/privacy](/docs/privacy). Telemetry events are retained for 90 days and then deleted. You can opt out at any time.

### Indexed content

releases.sh aggregates publicly available release notes, changelogs, and feeds. We do not collect personal data from publishers beyond what they have published on their own public pages. If you publish a changelog and want it removed from our index, see [Takedowns](#takedowns-and-content-removal) below.

## How we use data

- To operate the service and fetch updates from the sources we track.
- To enforce rate limits and prevent abuse of the API and MCP server.
- To understand aggregate usage patterns for the CLI and MCP.
- To respond to your questions and takedown requests.

We do not sell data. We do not use request logs or telemetry for advertising. We do not build user-level profiles; the CLI telemetry ID is a random UUID unlinked to any account, email, or machine identifier.

## Service providers

We use a small number of service providers to host and operate releases.sh. These providers receive request metadata as part of normal routing and logging.

- **Cloudflare** — hosts the API and supporting infrastructure.
- **Vercel** — hosts the web frontend.
- **Anthropic** — provides the AI models our indexing pipeline uses to parse and summarize public changelogs. These models receive only the public content we are indexing, never your queries or personal data.

## Security practices

We follow standard security practices for a service of this kind. Traffic is served over HTTPS, secrets and credentials are encrypted at rest, and access to production systems is limited to maintainers. We don't currently hold user accounts, sessions, or other authentication material, so there isn't much user-level data to secure beyond the anonymous telemetry described above.

## Retention

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

releases.sh does not offer user accounts, so we hold very little data that could be tied to an individual. If you want us to delete a specific telemetry ID, or if you have any other data-related question, email [privacy@releases.sh](mailto:privacy@releases.sh) and include the ID from `~/.releases/telemetry-id`.

## Changes

We may update this policy as the service changes. Material changes will be announced in the project's GitHub repository and reflected in the effective date above.

## Contact

- Privacy questions — [privacy@releases.sh](mailto:privacy@releases.sh)
- Takedowns and abuse — [abuse@releases.sh](mailto:abuse@releases.sh)
- Security reports — [security@releases.sh](mailto:security@releases.sh)
