# Contributing to Tollstile

Tollstile moves money for other people's software. Contributions are welcome, and they are held to that standard: correct first, then simple.

## Before you start

Read these once. Reviews refer to them.

- [PHILOSOPHY.md](./PHILOSOPHY.md) — what Tollstile is, and what it refuses to become
- [SPEC.md](./SPEC.md) — the normative contract every rail, ledger, and adapter must meet
- [DESIGN.md](./DESIGN.md) — why the model looks the way it does
- [CODING_RULES.md](./CODING_RULES.md) — how code is written here

For anything larger than a bug fix, open an issue first so the approach can be agreed before you write it.

## Development

Node 22.12+ and pnpm 9.

```bash
pnpm install
pnpm check   # lint, typecheck, and every test
```

- Every behavior change comes with a test that fails without it.
- A change to a payment path (verify, settle, refund, lookup, reconciliation, idempotency) also needs the case where the provider's answer is lost, and a check that nothing settles twice.
- A change that users of a published package can see needs a changeset: `npx changeset`.
- Never claim exactly-once execution in code, docs, or comments. The guarantee is no duplicate economic effects.

## Rails

A rail teaches Tollstile one way to be paid. There are three ways to ship one, and most rails should take them in this order.

### 1. In your own application

Write it with `createRail()` and pass it to `createTollstile({ rails })`. No permission or core change is needed. This is the right home for internal payment methods, private providers, and experiments. Guide: [Build a rail](https://tollstile.com/docs/rails/build-a-rail).

### 2. As a community rail

Publish it yourself so others can use it.

- Name it `tollstile-rail-<name>` or `@<scope>/tollstile-rail-<name>`, with the `tollstile-rail` keyword.
- Declare `tollstile` as a peer dependency.
- Run `railConformance()` in your tests, and state in your README which cases pass and why any are skipped.
- State what was verified against the provider's sandbox or testnet, and what was not.

To be listed on [Community rails](https://tollstile.com/docs/rails/community), open a [rail listing issue](https://github.com/tollstile/tollstile/issues/new?template=rail-listing.yml). Listing is not an endorsement; it means the checklist above is met.

### 3. As an official `@tollstile/*` rail

Official rails live in this repository and carry Tollstile's name, so users trust them with money on that name alone. A rail is accepted when **all** of these hold:

| Requirement | Why |
|---|---|
| Every conformance case passes, or is skipped for a reason that holds for the protocol | The baseline for correctness |
| A recorded run against the provider's sandbox or testnet: a payment, a replay, a handler failure, and a lost response resolved by reconciliation | A rail that only works against its own fake is not a rail |
| The protocol or provider has real users, and a public specification or API reference | It is worth maintaining |
| A named maintainer who answers issues for it, added to `CODEOWNERS` | Unmaintained payment code rots quietly |
| It meets SPEC.md: canonical payer ids, amounts checked against the quote or configuration, `proofId` on rejected-but-genuine proofs, provider failures thrown as `PROVIDER_*`, no secrets or payer evidence in errors, events, receipts, or logs, evidence redacted once final | These are the rules that keep money safe |
| No change to core, or a core change agreed in an issue first as a new capability or optional hook | Core stays protocol-neutral |
| A docs page and a README with capabilities, flows, stored data, retry behavior, and verification status | Users can judge it without reading the code |

The usual path is to start as a community rail, gain users and a sandbox record, then propose it for inclusion with a [rail proposal issue](https://github.com/tollstile/tollstile/issues/new?template=rail-proposal.yml). Open the pull request with the [rail template](https://github.com/tollstile/tollstile/compare/main...main?template=rail.md).

An official rail that loses its maintainer, or can no longer be verified against its provider, is marked unmaintained and may be removed in a later minor release.

## Security

Do not open public issues for vulnerabilities. Report them privately through [GitHub security advisories](https://github.com/tollstile/tollstile/security/advisories/new). See [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
