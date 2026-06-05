---
title: "Terms of Service"
description: "Accounts, acceptable use, rate limits, and takedown policy for the releases.sh web app, API, and MCP server."
effectiveDate: "June 5, 2026"
---

# Terms of Service

_Effective June 5, 2026_

These terms cover use of the releases.sh website, the public API, the remote MCP server, and the open-source CLI. By using any of these, you agree to the terms below. If you don't agree, please don't use the service.

## The service

releases.sh is a public index of release notes, changelogs, and version updates pulled from third-party sources. It is provided free of charge on a best-effort basis. We may change, rate-limit, suspend, or discontinue any part of the service at any time.

## Accounts

You don't need an account to use the public catalog, API, CLI, or MCP server. You may create one to manage API keys and other authenticated features. If you do:

- You must provide an accurate email address and keep it current, and you must be able to receive email at it (we use it for verification, password reset, and sign-in links).
- You are responsible for keeping your password, sign-in links, and API keys confidential, and for all activity that occurs under your account or your keys. Treat an API key like a password — anyone holding it can act with the access you granted it. If you believe a key or your account has been compromised, revoke the key and email [security@releases.sh](mailto:security@releases.sh).
- One person or entity per account; don't share credentials or impersonate someone else.
- We may suspend or terminate an account, and revoke its keys, for violating these terms or to protect the service or its users. You may delete your account at any time (see the [Privacy Policy](/privacy#your-rights)).

## Acceptable use

When you use the service, you agree not to:

- Circumvent, disable, or overload rate limits, authentication, or other protective measures.
- Scrape the service in a way that degrades performance for other users. Use the API or MCP endpoints — they exist so you don't have to scrape.
- Use the service to attack, probe, or reverse engineer third-party systems, or to distribute malware.
- Republish or resell bulk exports of the index in a way that competes with the service, removes attribution to publishers, or misrepresents releases.sh as the origin of the content.
- Use the service in violation of applicable law.

We may block IPs, revoke API keys, or otherwise restrict access to protect the service or its users.

## Rate limits and fair use

Unauthenticated endpoints are rate-limited per IP. Agents and integrations should handle rate-limit responses with exponential backoff. If you need higher limits for a legitimate integration, email [hi@releases.sh](mailto:hi@releases.sh).

## Content and attribution

The release notes, changelog entries, and product descriptions indexed by releases.sh are authored by the original publishers. We make no ownership claim over that content; copyright and other rights remain with the publishers. releases.sh surfaces the content for discovery and reference, typically with a link back to the source.

The site's own structure — schema, summaries, evaluations, and code — is produced by [Build Internet](https://buildinternet.com). The CLI is open source under the license in its repository.

## Takedowns

If you are a publisher or rights holder and want content removed from our index, email [abuse@releases.sh](mailto:abuse@releases.sh). Include the source or page URL and your relationship to the content. We aim to acknowledge within 3 business days and honor reasonable requests even when not legally required to. See the [Privacy Policy](/privacy#takedowns-and-content-removal) for more detail.

## Third-party content

releases.sh links to and summarizes content hosted elsewhere. We don't control that content and make no warranty about its accuracy. Follow the source link before acting on anything time-sensitive, and check the original publisher's license before redistributing their content.

## Disclaimer

The service is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose, accuracy, availability, or non-infringement. To the fullest extent permitted by law, Build Internet is not liable for any indirect, incidental, or consequential damages arising from your use of the service.

## Changes to these terms

We may update these terms as the service changes. Material changes will be announced in the project's GitHub repository and reflected in the effective date above. Continued use of the service after a change constitutes acceptance of the updated terms.

## Contact

- General — [hi@releases.sh](mailto:hi@releases.sh)
- Takedowns and abuse — [abuse@releases.sh](mailto:abuse@releases.sh)
- Security reports — [security@releases.sh](mailto:security@releases.sh)
- Privacy — [privacy@releases.sh](mailto:privacy@releases.sh)

## Revision history

- **April 20, 2026** — Initial version published.
- **June 5, 2026** — Added account terms (account responsibilities, credential and API-key security, suspension and termination).
