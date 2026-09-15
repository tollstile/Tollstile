# Security policy

Tollstile verifies payments and records money movements, so security reports are the highest-priority issues in this project.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through [GitHub security advisories](https://github.com/tollstile/tollstile/security/advisories/new).

Include what you can:

- the affected package and version
- what an attacker can do (for example: access a priced resource without paying, settle or refund twice, read payer evidence or secrets)
- steps or a test that reproduces it

You will get an acknowledgement within 3 business days. Please give us a reasonable time to release a fix before disclosing publicly; we will credit you in the advisory unless you ask otherwise.

## Scope

In scope: every package in this repository (`tollstile`, `@tollstile/*`, `create-tollstile`), the examples, and the specification in SPEC.md where following it would lead to an unsafe implementation.

Out of scope: vulnerabilities in payment providers, facilitators, chains, or community rails not maintained here — report those to their maintainers. Tollstile never holds funds; issues in your own handler or database configuration are yours to fix, though we welcome reports where our docs lead people astray.

## Supported versions

Tollstile is in Early Access (0.x). Fixes are released for the latest minor version only.
