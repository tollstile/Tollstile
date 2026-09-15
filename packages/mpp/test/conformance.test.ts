import { describe, it } from 'vitest';
import type { JsonObject, RailChallenge } from 'tollstile';
import { fakeClock, railConformance, type ConformanceCase, type RailHarness } from 'tollstile/testing';
import { mppStripe, mppTempo } from '../src/index';
import { fakeStripe } from './fake-stripe';
import { authorization, decodeJson, encodeJson, parseChallenges, type WireChallenge } from './mpp-client';
import { CHAIN_ID, RECIPIENT, TOKEN, fakeTempo, signTransaction, transfer, wallet } from './fake-tempo';

const SECRET = 'mpp-challenge-secret-0123456789abcdef';
const SEARCH_LAG_MS = 60_000;
const VALIDITY_MARGIN_MS = 60_000;

function challengeOf(challenge: RailChallenge): WireChallenge {
  const headers = new Headers();
  for (const [name, value] of challenge.headers) headers.append(name, value);
  const [parsed] = parseChallenges(headers);
  if (parsed === undefined) throw new Error('the rail offered no Payment challenge');
  return parsed;
}

/** Reads the credential of a paying request back, so a harness can rebuild it with one field changed. */
function credentialOf(request: Request): { challenge: WireChallenge; payload: JsonObject } {
  const header = request.headers.get('authorization') ?? '';
  return decodeJson(header.replace(/^Payment /, '')) as unknown as { challenge: WireChallenge; payload: JsonObject };
}

function paying(url: string, credential: string): Request {
  return new Request(url, { headers: { authorization: credential } });
}

function stripeHarness(): RailHarness {
  const stripe = fakeStripe();
  const clock = fakeClock();
  let tokens = 0;
  return {
    rail: mppStripe({ realm: 'localhost', secret: SECRET, secretKey: 'sk_test', networkId: 'profile_test', fetch: stripe.fetch, clock, searchLagMs: SEARCH_LAG_MS }),
    clock,
    price: '$1',
    pay: ({ offer, url }) => {
      tokens += 1;
      return Promise.resolve(paying(url, authorization(challengeOf(offer.challenge), { spt: `spt_conformance${String(tokens)}` })));
    },
    settlements: () => stripe.succeeded(),
    loseNextSettleResponse: () => {
      stripe.failNextPayment('timeout-after-effect');
    },
    failNextSettle: () => {
      stripe.failNextPayment('down');
    },
    // A cheaper amount in the echoed request breaks the HMAC binding.
    tamper: (request) => {
      const { challenge, payload } = credentialOf(request);
      const cheaper = encodeJson({ ...decodeJson(challenge.request ?? ''), amount: '50' });
      return paying(request.url, authorization({ ...challenge, request: cheaper }, payload));
    },
    reconcileAfterMs: SEARCH_LAG_MS + 1_000,
  };
}

function tempoHarness(mode: 'pull' | 'push'): RailHarness {
  const node = fakeTempo();
  const clock = fakeClock();
  const payer = wallet();
  const seconds = (offsetMs: number) => Math.floor((clock.now().getTime() + offsetMs) / 1000);
  let nonce = 0n;
  /** Every payment uses a new nonce, so each is a distinct transaction. */
  const signFresh = (challenge: WireChallenge, amountDelta = 0n) => {
    nonce += 1n;
    const request = decodeJson(challenge.request ?? '');
    const memo = (request.methodDetails as { memo: string }).memo;
    const amount = BigInt(request.amount as string) + amountDelta;
    return signTransaction(payer, { calls: [transfer(RECIPIENT, amount, memo)], validBefore: seconds(60_000), nonce });
  };

  return {
    rail: mppTempo({
      realm: 'localhost',
      secret: SECRET,
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      chainId: CHAIN_ID,
      recipient: RECIPIENT,
      token: { address: TOKEN, code: 'pathUSD' },
      denomination: 'USD',
      modes: [mode],
      validityMarginMs: VALIDITY_MARGIN_MS,
      fetch: node.fetch,
      clock,
    }),
    clock,
    price: '$1',
    pay: ({ offer, url }) => {
      const challenge = challengeOf(offer.challenge);
      const signed = signFresh(challenge);
      const payload = mode === 'pull' ? { type: 'transaction', signature: signed } : { type: 'hash', hash: node.include(signed) };
      return Promise.resolve(paying(url, authorization(challenge, payload)));
    },
    settlements: () => node.transfers(),
    // Push payments are already on-chain when presented and the rail never calls settle: there is no
    // settle fault to inject, and a tampered push proof is itself a transfer the kit would count.
    ...(mode === 'pull'
      ? {
          loseNextSettleResponse: () => {
            node.failNextSend('timeout-after-effect');
          },
          failNextSettle: () => {
            node.failNextSend('down');
          },
          // A transaction paying one base unit less, signed by the same payer.
          tamper: (request: Request) => paying(request.url, authorization(credentialOf(request).challenge, { type: 'transaction', signature: signFresh(credentialOf(request).challenge, -1n) })),
        }
      : {}),
    // Past `validBefore` plus the margin, so a missing receipt is final.
    reconcileAfterMs: 60_000 + VALIDITY_MARGIN_MS + 1_000,
  };
}

function run(cases: readonly ConformanceCase[]) {
  for (const test of cases) {
    if (test.skip !== undefined) it.skip(`${test.name} (${test.skip})`, () => undefined);
    else it(test.name, () => test.run());
  }
}

describe('rail conformance: mppStripe', () => {
  run(railConformance(stripeHarness));
});

describe('rail conformance: mppTempo pull', () => {
  run(railConformance(() => tempoHarness('pull')));
});

describe('rail conformance: mppTempo push', () => {
  run(railConformance(() => tempoHarness('push')));
});
