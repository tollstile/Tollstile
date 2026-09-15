# Coding Rules

These rules apply to every contribution — human or AI-generated.
If a rule and "getting it to work" conflict, the rule wins. If a rule is wrong, change the rule in a PR, don't bypass it.

## 0. Priorities

When trade-offs arise, decide in this order:

1. **Money correctness** — no unpaid access, no duplicate economic effects, no hidden outcomes.
2. **Security** — fail closed, verify everything, trust nothing from the wire.
3. **Neutrality** — no rail, provider, or platform gets special treatment.
4. **Public API ergonomics** — small, typed, obvious.
5. **Simplicity** — less code, fewer concepts.
6. **Performance** — only with a benchmark.

See [PHILOSOPHY.md](./PHILOSOPHY.md) for the reasoning behind these.

---

## 1. Architecture

```
packages/
  tollstile/                 # published as `tollstile`
    src/core/                # lifecycle state machine, access evaluation, ledger and rail contracts
    src/policies/            # whether a caller pays: subscriber, credits, pay-per-call
    src/requirements/        # conditions: limit, payers, when
    src/rails/test/          # the built-in test rail
    src/ledgers/memory/      # the built-in memory ledger
    src/testing/             # `tollstile/testing`: fake clock and test helpers
  hono/  mcp/  next/ …       # adapters, published as `@tollstile/<name>`
  x402/  mpp/                # live rails, published as `@tollstile/<name>`
  postgres/                  # ledgers with external dependencies, published as `@tollstile/<name>`
```

- Layers that need no dependencies ship inside `tollstile`; anything that brings a dependency or talks to a network gets its own package.
- Dependency direction is one-way: `adapters → rails | policies | requirements | ledgers → core`. `core` imports nothing from the other layers, and those layers do not import each other. ESLint enforces this for the folders inside `tollstile`.
- **Rails and policies never mix.** A rail answers *how* a payment is made and proven. A policy answers *whether* the caller pays and *what it costs*. A subscription or credit balance is never a rail.
- **Rails declare capabilities** (`flows`, `authorization` kind, `variableAmount`, `quotes`, `refund`, `partialRefund`, `lookup`). Core never assumes a capability; a route that needs an undeclared capability throws where it is defined.
- `core` uses **Web standard APIs only** (`Request`, `Response`, `fetch`, `crypto.subtle`, `TextEncoder`). No Node built-ins. It must run on Node, Bun, Deno, and Workers.
- `core` has **zero runtime dependencies**. Other packages may add dependencies only with maintainer approval.
- Tollstile **never takes custody of funds**. It verifies proofs, requests settlement and refunds from the rail's provider, and records results. It never holds balances or converts assets.

---

## 2. Error Handling

### 2.1 Expected outcomes are values, not exceptions

"Payment missing", "payment invalid", "insufficient credits" are normal control flow. Model them as discriminated unions.

```ts
type VerifyResult =
  | { status: "paid"; receipt: Receipt }
  | { status: "required"; challenge: PaymentChallenge }
  | { status: "invalid"; reason: InvalidReason };
```

### 2.2 Throw only for the unexpected, and only `TollstileError`

```ts
throw new TollstileError("PROVIDER_UNAVAILABLE", { cause: err });
```

- Never throw a bare `Error`, string, or object.
- Every error has a stable `code` (part of the public API) and preserves `cause`.
- Error messages state what happened and what to do: `"Invalid price \"0.01\": use a string like \"$0.01\""`.

### 2.3 Where `try/catch` is allowed

| Location | Allowed? |
|---|---|
| `adapters/*` request entry point (one per adapter) | ✅ Convert errors into HTTP responses |
| `core/` lifecycle — record `unknown` when a provider outcome is ambiguous | ✅ The single designated location, with `// catch-reason:` |
| `rails/*` — converting a failed provider `fetch` into `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT` | ✅ With `// catch-reason:` comment |
| `rails/*` — retry around an idempotent provider call | ✅ Bounded attempts, explicit retryable codes |
| `core/*` | ❌ Lint error. Requires an `eslint-disable` with a written justification and maintainer review |
| Anywhere, to log and continue | ❌ Never |
| Anywhere, to log and rethrow | ❌ Never — rethrowing adds nothing |
| Anywhere, to return a default value | ❌ Never |

### 2.4 Fail closed

On any unexpected error during verification or access evaluation, the request is **denied** (`503` for infrastructure failure, `402` for payment problems). There is no code path where an exception results in serving the protected resource.

Failures **after** access is granted (settlement, refund) are never converted into "success" or "failure" by guesswork. They become recorded states — see §3.

### 2.5 Fail fast on configuration

Invalid config (price format, recipient address, network, missing or weak secret, missing rail capability, unsupported flow) throws at `createTollstile()` or where the route is defined, not at request time. Once constructed, the instance is valid — do not re-check config at runtime.

---

## 3. Money & Payment Invariants

- **No floating-point money.** Prices are `Money` (`{ currency, micros: bigint }`); rail amounts are integer asset units on an `Offer`. Human strings like `"$0.01"` are parsed once. Price currency and settlement asset are never silently equated — par conversion is explicit in rail configuration.
- **The server decides the price.** Amount, asset, network, and recipient are checked against the signed quote or server config — never taken from the client payload.
- **Replay protection is mandatory.** Authorizations are keyed by rail and proof; a single-use proof backs at most one charge that was not released. Nonces go through the ledger's `claims`.
- **Never claim exactly-once execution** in code, docs, or comments. The invariant is **no duplicate economic effects**.
- **Charges are state machines on two axes** (payment × fulfillment, see `core/states.ts` and DESIGN.md). Transitions are validated against the tables; an invalid transition is a `TollstileError`, never a silent overwrite.
- **Reserve, then commit or release.** Creating a charge reserves capacity on its authorization atomically. Value held by policies (credits) follows the same discipline through `Balance`.
- **Write-ahead transitions.** Record the intended state (`settling`, `refund_pending`) before calling a provider, and the result after. Recovery reads the ledger, never in-memory state.
- **Idempotency keys come from the charge.** A repeated call with the same key returns the recorded result.
- **`unknown` is a state.** A timeout or ambiguous provider response becomes `unknown`, resolved only by `lookup`. Never assume success or failure.
- **Quotes fix prices and bind requests.** A single-use proof carrying a quote is charged at the quoted price and must match the quote's request commitment. Quotes are signed and never stored.
- **Flows are explicit.** `authorization` or `upfront`, declared by rails and chosen per route; `escrow` is refused until implemented.
- **Fulfillment is defined, not inferred.** Default: handler completed successfully. `payment.fulfill()` marks it explicitly. Response delivery is not fulfillment.
- **Time is injected.** Use the `clock` from context; never call `Date.now()` directly in `core` or `rails`. Expiry checks must be testable.
- **Secrets never leave memory.** Never log, include in errors, events, or receipts: private keys, API keys, raw payment payloads, signatures, bearer tokens.
- **Payer evidence is stored only while it is needed.** A rail may keep a signed payload in authorization `data` when settlement after a crash needs it. It must implement `redact` so the evidence is dropped once the charge is final, keeping only what `lookup` and `refund` need. Bearer tokens that can pay again (e.g. an SPT) never reach the ledger.
- **Constant-time comparison** for any secret or signature comparison.

---

## 4. TypeScript

### 4.1 Compiler

`strict: true` plus:

```json
{
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true
}
```

### 4.2 Forbidden

- `any` (explicit or implicit)
- `as unknown as T`, and `as T` except to narrow a validated value
- Non-null assertion `!`
- `// @ts-ignore` (use `// @ts-expect-error` with a reason, tests only)
- `enum` — use string literal unions
- Optional chaining / nullish fallback on values the type says are defined

### 4.3 Required

- **Validate at the boundary, trust inside.** Wire data (headers, bodies, provider responses) enters as `unknown` and is parsed once into a typed value. After that, no defensive checks.
- **Exhaustive switches** on unions:
  ```ts
  default: {
    const _exhaustive: never = result;
    throw new TollstileError("UNREACHABLE", { cause: _exhaustive });
  }
  ```
- `import type` for type-only imports.
- `readonly` for public types and config objects.
- Public types are **inferred-friendly**: adding a rail or policy must extend handler context types automatically, with no manual generics or module augmentation.
- **Payment state is a discriminated union**, so code cannot read `receipt` on a payment that isn't settled.

---

## 5. Public API

- **Small surface.** Every exported symbol is a long-term commitment. New exports require maintainer approval.
- **One way to do a thing.** No aliases, no overloads that do the same job.
- **Options objects** for anything with more than two parameters.
- **Names describe the domain**, not the implementation: `price()`, `verify()`, `refund()` — not `processPaymentHeaderMiddlewareHandler()`.
- **JSDoc on public exports only**, with one example each. No JSDoc on internals.
- Public API changes are detected by API Extractor in CI. Breaking changes require a major version and a changeset.

---

## 6. Code Style

- **No single-use abstractions.** Don't extract a function, class, or file used in one place unless it names a real domain concept.
- **No speculative generality.** No options, hooks, or extension points without a current use case.
- **Early return** over nested conditionals.
- **Comments explain why, never what.** Delete comments that restate the code.
- **No `console.*`** in library code. Observability goes through typed event hooks (`onPaid`, `onRefund`, `onError`) that the user wires to their logger.
- **No dead code**, commented-out code, or TODOs without an issue link.
- **Files:** `kebab-case.ts`. One primary export concept per file.
- **Match surrounding code.** Consistency beats personal preference.

---

## 7. Async

- No floating promises. Every promise is awaited, returned, or explicitly `void`-ed with a reason.
- Every outbound network call has an explicit **timeout** and accepts an `AbortSignal`.
- Retries live only in the rail's provider client — not scattered at call sites — and only for operations the rail declares idempotent.
- No `async` on functions that don't `await`.

---

## 8. Testing

- **Failure modes first.** Every rail must pass the shared conformance suite before merging:
  - provider unavailable or timing out during verification → `503`, handler not called
  - invalid / expired / wrong-amount / wrong-asset / wrong-recipient proof → `402`, handler not called
  - replayed proof → rejected, no second economic effect
  - handler throws → charge released (authorization flow) or refunded (upfront); replaying the failure produces no second refund
  - settle times out → payment `unknown`; reconciliation resolves it to the provider's actual outcome
  - process crash between any two transitions → recovery from the ledger produces no duplicate settle, void, or refund
  - settle fails after fulfillment → recorded and surfaced via `onError`, never silently dropped
  - configuration requiring an undeclared capability → throws where the route is defined
- Every policy must pass its own conformance suite (ordering, credit draw-down idempotency, concurrent requests against the same balance).
- Use `@tollstile/testing` fakes (provider, clock, wallet). The fake provider must be able to inject timeouts, duplicate deliveries, and crashes. **Do not mock internal modules.**
- Tests assert behavior through the public API, not implementation details.
- No real network or real funds in unit tests. Testnet integration tests run separately in CI.
- **Never weaken, skip, or delete a test to make a change pass.**
- Coverage is not a target; the failure-mode list above is.

---

## 9. Dependencies

- Prefer the platform over a package.
- Any new dependency needs: justification in the PR, license check (MIT/Apache-2.0/BSD), bundle size impact, maintenance status.
- Crypto primitives come from well-audited libraries or `crypto.subtle` — never hand-rolled.

---

## 10. Documentation & Changes

- Every user-visible change includes a **changeset**.
- Docs examples are type-checked in CI.
- README's first example must go from install to first paid request in under 5 minutes, using `testRail()` and `memoryLedger()` — no wallet, network, or account.
- Documentation states guarantees and non-guarantees precisely. Words like "exactly once", "always settles", or "guaranteed delivery" are not allowed.

---

## 11. Rules for AI-Assisted Contributions

AI agents working in this repository must follow everything above, plus:

- **Do not** add `try/catch` to satisfy an error you don't understand. Find the cause.
- **Do not** add defensive checks, fallbacks, or default values "just in case".
- **Do not** add dependencies, exports, config options, or new files outside the task's scope.
- **Do not** modify tests to make them pass. If a test is wrong, stop and explain.
- **Do not** add comments that narrate the change ("// Added validation here").
- **Do** run `pnpm lint && pnpm typecheck && pnpm test` and fix all failures before finishing.
- **Do** keep diffs minimal. Refactors go in separate PRs.
- **Do** state explicitly in the PR description any place where money flow or error handling changed.

Humans own: error taxonomy, public types, money invariants, and final review of anything touching §2 or §3.

---

## 12. Enforcement

| Rule | Enforced by |
|---|---|
| No `try` in `core` | ESLint `no-restricted-syntax: TryStatement` |
| Justified disables | `@eslint-community/eslint-comments/require-description` |
| No useless catch | `no-useless-catch` |
| Throw only errors | `@typescript-eslint/only-throw-error` |
| No `any` | `@typescript-eslint/no-explicit-any`, `no-unsafe-*` |
| No `!` | `@typescript-eslint/no-non-null-assertion` |
| No needless `?.` / `??` | `@typescript-eslint/no-unnecessary-condition` |
| No floating promises | `@typescript-eslint/no-floating-promises` |
| No async without await | `@typescript-eslint/require-await` |
| Exhaustive switches | `@typescript-eslint/switch-exhaustiveness-check` |
| No `console` | `no-console` |
| No `Date.now()` in core/rails | `no-restricted-properties` |
| No Node built-ins in core | `no-restricted-imports: node:*` |
| Package boundaries | `eslint-plugin-boundaries` or dependency-cruiser |
| Public API changes | API Extractor report diff |
| Failure-mode tests | Shared suites every rail and policy must pass (`runRailConformance()`, `runPolicyConformance()`) |
| Valid state transitions | Transition table in core + property-based tests over random failure injection |
