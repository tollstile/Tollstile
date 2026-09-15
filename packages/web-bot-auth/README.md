# @tollstile/web-bot-auth

`verifiedAgent()` is a Tollstile requirement that admits only requests signed by an agent you trust, using [Web Bot Auth](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/): [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP message signatures whose keys are published at the agent's `/.well-known/http-message-signatures-directory`.

It answers *who* is calling, not whether they paid. Put it in `require` next to any rail or access policy; it runs after the payer is known and before anything is reserved, so a denied request never touches the ledger.

## Install

```bash
npm install tollstile @tollstile/web-bot-auth
```

## Example

```ts
import { createTollstile, memoryLedger, testRail } from 'tollstile';
import { paid } from '@tollstile/fetch';
import { verifiedAgent } from '@tollstile/web-bot-auth';

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

export default {
  fetch: paid(
    toll.price('$0.01', { require: [verifiedAgent({ trust: ['https://agent.example'] })] }),
    () => Response.json({ forecast: 'clear' }),
  ),
};
```

A request is admitted when it carries a valid payment **and** a signature like:

```http
Signature-Agent: sig1="https://agent.example"
Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent";key="sig1");created=1767225600;expires=1767225660;keyid="<JWK thumbprint>";alg="ed25519";nonce="…";tag="web-bot-auth"
Signature: sig1=:…:
```

Otherwise the response is `403` with `{ "error": "requirement_failed", "requirement": "verified-agent", "reason": "…" }`, or `503` with reason `directory_unavailable` when the agent's key directory cannot be reached right now.

## Options

| Option | Default | Description |
|---|---|---|
| `trust` | required | Signature-Agent origins you accept (`["https://agent.example"]`), or `(origin) => boolean`. Only these origins' directories are ever fetched. A predicate is your SSRF boundary: the library cannot block private address ranges with Web-standard `fetch`. |
| `maxAgeMs` | `300000` | Oldest `created` accepted. |
| `clockSkewMs` | `5000` | Tolerance applied to `created`, `expires`, and the maximum age. |
| `requireNonce` | `false` | Reject signatures without a `nonce`. Nonces that are present are always single-use. |
| `cacheTtlMs` | `3600000` | Longest a directory is reused. A shorter `Cache-Control: max-age` wins, but never below one minute. |
| `timeoutMs` | `3000` | Upper bound for one directory fetch, including the body. The fetch is also aborted when Tollstile's `providerTimeoutMs` elapses (`input.signal`). |
| `fetch` | global `fetch` | Inject for tests or egress proxies. |

## What is checked

In this order, for each signature whose `tag` is `web-bot-auth` (the first that verifies wins):

1. `Signature-Input` and `Signature` parse as RFC 8941 Dictionaries; only the parameters RFC 9421 defines are allowed.
2. `created`, `expires`, and `keyid` are present; `@authority` or `@target-uri` is covered without parameters.
3. `created` is not in the future, `expires` has not passed, and `created` is within `maxAgeMs` (each ± `clockSkewMs`).
4. The covered Signature-Agent member: exactly one `"signature-agent";key="<member>"` for the Dictionary form, or `"signature-agent"` for the legacy sf-string form. The member must be an HTTPS origin; `type=jwks_uri` and `type=cimd` members are not resolved.
5. The signature base is rebuilt from `context.request` only — method, URL, and headers as the server received them. A missing, duplicated, or unsupported component fails.
6. The origin is trusted, its directory resolves, and it contains a key whose RFC 7638 thumbprint equals `keyid` (a `kid` that is not the thumbprint disqualifies the entry). RFC 9421's published test keys are refused.
7. The algorithm follows from the key (`ed25519`, `ecdsa-p256-sha256`, `ecdsa-p384-sha384`, `rsa-pss-sha512`); a signature `alg` must agree. RSA keys must name `PS512`/`rsa-pss-sha512` in the key or the signature.
8. A `nonce`, if present, is claimed once per directory and key until the signature could no longer be accepted.

| Reason | Meaning |
|---|---|
| `http_request_required` | MCP call, or no HTTP request in the context. MCP tool calls are never attributed to a signed HTTP request. |
| `signature_missing` / `signature_malformed` / `tag_missing` | No usable Web Bot Auth signature. |
| `signature_parameters_missing` / `target_not_covered` | Profile requirements not met. |
| `signature_not_yet_valid` / `signature_expired` / `signature_too_old` | Freshness. |
| `signature_agent_missing` / `signature_agent_not_covered` / `signature_agent_malformed` / `signature_agent_unsupported` | The Signature-Agent member cannot be attributed. |
| `signature_base_invalid` | A covered component cannot be derived from the request. |
| `agent_untrusted` | The origin is not in `trust`. Nothing was fetched. |
| `directory_unavailable` (**503**) | The directory could not be reached — network or TLS error, timeout (`timeoutMs` or the provider timeout), or a 5xx — and nothing usable is cached. The request is unverified, not forbidden; retry later. |
| `directory_invalid` | The directory answered, but not with a usable directory: a redirect, another non-200 status, over 64 KiB, more than 32 keys, or malformed JSON. The operator has to fix it. |
| `key_not_found` / `algorithm_mismatch` / `signature_invalid` | Key selection or cryptographic verification failed. |
| `nonce_missing` / `nonce_replayed` | Replay protection. |

## Directory discovery

- `GET https://<origin>/.well-known/http-message-signatures-directory` with `redirect: "manual"`; only `200` is accepted. Unreachable directories and 5xx are `directory_unavailable` (503); redirects, other statuses, bodies over 64 KiB, more than 32 keys, or malformed JSON are `directory_invalid` (403). Unsupported or malformed key entries are skipped.
- Unavailability is returned as `{ ok: false, status: 503 }` rather than thrown as `PROVIDER_UNAVAILABLE`, so the response keeps the specific reason; either way nothing is reserved.
- Concurrent requests for the same origin share one fetch, bounded by the signal of the request that started it. At most 1,024 directories are cached.
- A directory that resolves replaces the cached one, so a removed key stops verifying. A failed fetch of either kind is not evidence: the cached directory keeps verifying for up to 24 hours past its expiry, and the origin is not retried for 30 seconds.
- The cache and in-flight fetches are per `verifiedAgent()` instance and per process.

## Deployment notes

- **Reconstruct the public URL.** `@authority` and `@target-uri` come from `request.url`. Behind a proxy, the adapter must build the URL the agent signed (e.g. Express `trust proxy`), or every signature fails.
- **Cover more than `@authority`.** A signature over `@authority` alone can be replayed against any path until it expires. Ask agents to cover `@method` and `@path`, or require nonces.
- **Nonce claims and retries.** A nonce is claimed before the charge is created, so a request whose handler fails cannot be retried with the same signature; agents sign each attempt.

## Verification status

Tested with Vitest (Node 22 WebCrypto) against:

- RFC 9421 Appendix B.2.6 (ed25519), B.2.2 and B.2.3 (rsa-pss-sha512, including `@query-param` and `@query`), and the §2.2.8 query encoding examples — signature bases rebuilt byte for byte and signatures verified.
- draft-ietf-webbotauth-httpsig-protocol-00 Appendix E.1.1, E.1.2, E.2.1, and E.2.2 (Dictionary and legacy Signature-Agent, ed25519 and rsa-pss-sha512).
- Full requirement flows through `createTollstile` with `testRail()`, fake directories via injected `fetch`, and freshly generated ed25519, P-256, and RSA-PSS keys: untrusted origins never fetched, redirects and non-200 refused, size and key-count caps, 503 for unreachable, 5xx, `timeoutMs`, and provider-timeout (`input.signal`) failures, stale-on-failure caching and its 24-hour limit, `max-age` handling, fetch coalescing, nonce replay, and MCP fail-closed.

Not verified against a live agent. To verify: sign a request with Cloudflare's reference signer ([`web-bot-auth`](https://github.com/cloudflare/web-bot-auth), `sign()` with `signatureAgentKey`), host its JWKS at `https://<your-agent>/.well-known/http-message-signatures-directory`, trust that origin, and call your endpoint — expect `200`; change one covered header and expect `403 signature_invalid`.

## Not implemented

- **Visa Trusted Agent Protocol.** TAP reuses RFC 9421 with tags `agent-browser-auth`/`agent-payer-auth`, `@authority` + `@path`, mandatory nonces, and an 8-minute window, but keys come from Visa's JWKS selected by `kid` rather than a Signature-Agent thumbprint, algorithm names are JOSE names or the unregistered `rsa-pss-sha256`, and Visa's reference agent emits `Signature-Input` parameters that are not valid RFC 8941 (`keyId`, spaces). A strict verifier would reject its own samples, so a `tap` option is future work pending a conformant signer and published test vectors.
- `jwks_uri` and `cimd` Signature-Agent types, directory response signatures (Appendix B), and requests without Signature-Agent (thumbprint-only identity).
- Exposing the verified agent identity to the handler: requirements return only pass or fail.
