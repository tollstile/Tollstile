## Rail

- **Name:** `@tollstile/<name>`
- **Protocol / provider:** <!-- link to the public specification or API reference -->
- **Maintainer (added to CODEOWNERS):** @<github-handle>
- **Proposal issue:** #<number>

## Capabilities

| Capability | Value | Why |
|---|---|---|
| `flows` | | |
| `authorization` | | |
| `variableAmount` | | |
| `quotes` | | |
| `refund` / `partialRefund` | | |

## Conformance

<!-- Paste the railConformance() results. Every skip needs a reason that holds for the protocol. -->

## Sandbox or testnet verification

<!-- Date, environment (network, test mode), and what was run: a payment, a replay, a handler failure,
a lost response resolved by reconciliation. Transaction or payment references where public. -->

## SPEC.md

- [ ] Payer ids are canonical and documented
- [ ] Amount, asset, network, and recipient are checked against the quote or configuration
- [ ] `proofId` is returned on proofs that are genuine but no longer acceptable
- [ ] Provider failures throw `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT`; every known outcome is a value
- [ ] `settle` and `refund` pass `operation.key` (or deduplicate by charge id)
- [ ] `lookup` answers from the provider's records
- [ ] Payer evidence in `data` is dropped by `redact`; bearer credentials are never stored
- [ ] No secrets or evidence in errors, events, receipts, or logs
- [ ] No core change, or the core change was agreed in an issue

## Docs

- [ ] `packages/<name>/README.md` with capabilities, flows, stored data, retry behavior, verification status
- [ ] A docs page under Rails
- [ ] A changeset
