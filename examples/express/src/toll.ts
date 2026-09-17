import { createTollstile, memoryBalance, memoryLedger, testRail } from 'tollstile';

// The test rail runs the whole payment lifecycle in this process: no wallet, network, or account.
// A client pays by sending `Payment: test quote=<quote>` with the quote from the 402.
export const toll = createTollstile({
  rails: [testRail()],
  ledger: memoryLedger(),
});

/** Prepaid credits by customer account. In memory here; back it with your database in production. */
export const creditBalance = memoryBalance({ acct_demo: '$0.10' });

// ─── Use real payments ────────────────────────────────────────────────────────
// To accept USDC on Base Sepolia through x402, replace `toll` above with the block below.
// Routes and handlers do not change. Set PAY_TO (your receiving address) and TOLLSTILE_SECRET
// (32+ random characters); a missing value fails at startup with a message saying which.
// See "Use real payments" in README.md: this example's x402 block has not itself been run live; the rail's `exact` scheme has, on Base Sepolia.
//
// import { x402 } from '@tollstile/x402';
//
// export const toll = createTollstile({
//   rails: [
//     x402({
//       network: 'eip155:84532', // Base Sepolia
//       payTo: process.env.PAY_TO ?? '',
//       denomination: 'USD', // 1 USDC = 1 USD, stated explicitly
//       rpcUrl: process.env.RPC_URL ?? 'https://sepolia.base.org', // used by toll.reconcile()
//     }),
//   ],
//   ledger: memoryLedger(), // use a database ledger in production
//   secret: process.env.TOLLSTILE_SECRET, // required with live rails: startup fails with a clear message if missing
// });
