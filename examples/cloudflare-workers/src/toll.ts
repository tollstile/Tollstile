import { createTollstile, memoryLedger, testRail } from 'tollstile';

// The test rail runs the whole payment lifecycle in this Worker: no wallet, network, or account.
// A client pays by sending `Payment: test quote=<quote>` with the quote from the 402.
export function createToll() {
  return createTollstile({
    rails: [testRail()],
    ledger: memoryLedger(),
  });
}

// ─── Use real payments ────────────────────────────────────────────────────────
// To accept USDC on Base Sepolia through x402, replace `createToll` above with the block below and
// pass the Worker's `env` to it in src/index.ts. Set the bindings with `wrangler secret put` (or in
// .dev.vars for `wrangler dev`): PAY_TO, your receiving address, and TOLLSTILE_SECRET, 32+ random
// characters. A secret is required anyway once deployed: without one, each isolate signs quotes with
// its own random key and rejects quotes issued by another.
// See "Use real payments" in README.md: this example's x402 block has not itself been run live; the rail's `exact` scheme has, on Base Sepolia.
//
// import { x402 } from '@tollstile/x402';
//
// export type Env = { readonly PAY_TO: string; readonly TOLLSTILE_SECRET: string };
//
// export function createToll(env: Env) {
//   return createTollstile({
//     rails: [
//       x402({
//         network: 'eip155:84532', // Base Sepolia
//         payTo: env.PAY_TO,
//         denomination: 'USD', // 1 USDC = 1 USD, stated explicitly
//         rpcUrl: 'https://sepolia.base.org', // used by toll.reconcile()
//       }),
//     ],
//     ledger: memoryLedger(), // per isolate: use a database ledger once deployed
//     secret: env.TOLLSTILE_SECRET,
//   });
// }
