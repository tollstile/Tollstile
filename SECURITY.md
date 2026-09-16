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

## Pricing a request costs something

Answering `402` is work a caller asks for without paying: the body may be read to compute a price, a quote is signed, and a rail may contact its provider to build a challenge. Tollstile bounds what one request can ask for — a body larger than `maxRequestBytes` (1 MiB by default) is refused before any of it happens, and a quote token longer than 8 KiB is refused before it is hashed — but it cannot bound **how many** requests arrive.

Rate limiting belongs in front of the service: a CDN, a gateway, or your framework. Two things are worth knowing when you set it:

- A body with no declared length is bounded by your runtime, not by `maxRequestBytes`.
- Rails that call a provider during `challenge()` turn unauthenticated requests into outbound calls on your account. Check what each rail you enable does there.

`limit()` is not this: it caps what a **payer** spends, and a payer is only known after a proof is verified.

## Supported versions

Tollstile is in Early Access (0.x). Fixes are released for the latest minor version only.
