# Security Policy

Helmio manages `supervisord` instances across remote servers and therefore
handles sensitive material: SSH access, JWT secrets, encrypted connection
credentials (`secretBox`), API tokens and audit data. We take security reports
seriously.

## Supported versions

Helmio is pre-1.0 software. Security fixes are applied to the latest released
version on the `main` branch only.

| Version        | Supported |
| -------------- | --------- |
| `0.x` (latest) | ✅        |
| older `0.x`    | ❌        |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately through one of the following channels:

1. **GitHub Security Advisories** (preferred) — open a draft advisory at
   <https://github.com/fahrettinaksoy/helMiO/security/advisories/new>.
2. **Email** — send details to the maintainer listed on the GitHub profile
   [@fahrettinaksoy](https://github.com/fahrettinaksoy).

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected endpoints/components).
- Affected version(s) / commit hash.
- Any suggested remediation, if known.

## What to expect

- **Acknowledgement** within **72 hours**.
- An initial assessment and severity classification within **7 days**.
- We will keep you informed about progress toward a fix and coordinate a
  disclosure timeline with you. We aim to ship a fix within **30 days** for
  high-severity issues.
- With your permission, we will credit you in the release notes.

## Scope & hardening notes

When self-hosting Helmio, you are responsible for the security of your
deployment. At minimum:

- **Never run with default/example secrets.** Set a strong, unique
  `JWT_SECRET` and the `secretBox` encryption key. The values in
  `*.env.example` are placeholders only.
- Serve the panel over **HTTPS** behind a reverse proxy.
- Restrict network access to target `supervisord` instances (TCP XML-RPC,
  Unix socket over SSH) to trusted hosts.
- Rotate API tokens regularly and grant the minimum RBAC role required.
- Keep dependencies up to date (Dependabot is enabled in this repo).

Thank you for helping keep Helmio and its users safe.
