# Security policy

permly decides who may do what in your app, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/PJPhukan/permly/security/advisories/new)
(Security tab → "Report a vulnerability").

Helpful details: the permly version, the adapter (memory, MySQL, Postgres, MongoDB) and
framework you use, what you expected, what happened, and the smallest code that shows it.

## What to expect

- An acknowledgement within **3 days**.
- A first assessment (confirmed or not, and severity) within **7 days**.
- For confirmed issues, a fix or a mitigation as soon as possible, usually within 30 days,
  and a published advisory crediting you (unless you prefer not to be named).

## Supported versions

permly is pre-1.0. Security fixes go into the latest `0.x` release.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Scope

In scope: anything that lets a check (`can`, `hasRole`, the Express middleware, ...) allow
access it shouldn't, SQL/NoSQL injection, and leaking secrets (e.g. the CLI printing a
database password). Out of scope: problems that need a malicious or misconfigured app, such
as trusting a user id taken straight from a request header.
