import { describe, expect, it } from 'vitest';
import { parseMoney } from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { mppTempo, type MppTempoOptions } from '../src/index';
import { authorization, challengeFor, decodeJson, get, setup, type WireChallenge } from './mpp-client';
import { CHAIN_ID, RECIPIENT, TOKEN, fakeTempo, signTransaction, transfer, wallet, type Call } from './fake-tempo';

const SECRET = 'mpp-challenge-secret-0123456789abcdef';
const PLATFORM = '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function tempoSetup(overrides: Partial<MppTempoOptions> = {}) {
  const node = fakeTempo();
  const clock = fakeClock();
  const rail = mppTempo({
    realm: 'api.example.com',
    secret: SECRET,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    chainId: CHAIN_ID,
    recipient: RECIPIENT,
    token: { address: TOKEN, code: 'pathUSD' },
    denomination: 'USD',
    fetch: node.fetch,
    clock,
    ...overrides,
  });
  const payer = wallet();
  const context = setup(rail, clock);
  const seconds = (offsetMs: number) => Math.floor((clock.now().getTime() + offsetMs) / 1000);

  /** Signs the transfer a challenge asks for, with optional changes to show what the rail refuses. */
  const pay = (challenge: WireChallenge, change: { calls?: (memo: string, amount: bigint) => Call[]; validBefore?: number; chainId?: number; feePayerMarker?: boolean } = {}) => {
    const request = decodeJson(challenge.request ?? '');
    const details = request.methodDetails as { memo: string };
    const amount = BigInt(request.amount as string);
    const calls = change.calls?.(details.memo, amount) ?? [transfer(RECIPIENT, amount, details.memo)];
    return signTransaction(payer, {
      calls,
      validBefore: change.validBefore ?? seconds(60_000),
      ...(change.chainId === undefined ? {} : { chainId: change.chainId }),
      ...(change.feePayerMarker === undefined ? {} : { feePayerMarker: change.feePayerMarker }),
    });
  };
  const credential = (challenge: WireChallenge, signature: string) => authorization(challenge, { type: 'transaction', signature });
  return { node, rail, payer, pay, credential, seconds, ...context };
}

describe('mppTempo challenge', () => {
  it('asks for a memo-bound TIP-20 transfer and settles after the handler', async () => {
    const { toll } = tempoSetup();
    const result = await get(toll.price('$0.01'));
    const request = decodeJson((await challengeFor(toll.price('$0.01'))).request ?? '');

    expect(result.body.accepts).toMatchObject([{ rail: 'mpp-tempo', asset: { code: 'pathUSD', network: 'eip155:42431', scale: 6 }, amount: '10000', flow: 'authorization' }]);
    expect(request).toMatchObject({
      amount: '10000',
      currency: TOKEN,
      recipient: RECIPIENT,
      methodDetails: { chainId: CHAIN_ID, supportedModes: ['pull'], memo: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown },
    });
  });

  it('offers nothing for prices in another currency', async () => {
    const { rail } = tempoSetup();
    expect(await rail.offer({ resource: 'GET /report', price: parseMoney('€1.00'), variable: false })).toBeNull();
  });
});

describe('mppTempo pull mode', () => {
  it('verifies offline, runs the handler, then broadcasts and returns the transaction hash', async () => {
    const { toll, node, pay, credential, payer, charges, ledger } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const signed = pay(challenge);
    let broadcastsDuringHandler = -1;
    const result = await get(gate, { authorization: credential(challenge, signed), handler: () => (broadcastsDuringHandler = node.broadcasts.length) });

    expect(result.status).toBe(200);
    expect(broadcastsDuringHandler).toBe(0);
    expect(node.broadcasts).toEqual([signed]);
    expect(charges()).toEqual(['settled/completed']);
    expect(ledger.authorizations()[0]?.payer).toBe(`did:pkh:eip155:${String(CHAIN_ID)}:${payer.address}`);
    const receipt = decodeJson(result.headers.get('payment-receipt') ?? '');
    expect(receipt).toMatchObject({ status: 'success', method: 'tempo', challengeId: challenge.id });
    expect(node.receipts.has(receipt.reference as string)).toBe(true);
  });

  it('broadcasts nothing when the handler fails, and accepts the same credential again', async () => {
    const { toll, node, pay, credential, charges } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const proof = credential(challenge, pay(challenge));

    await get(gate, { authorization: proof, outcome: 'failed' });
    expect(charges()).toEqual(['released/failed']);
    expect(node.broadcasts).toHaveLength(0);

    expect((await get(gate, { authorization: proof })).status).toBe(200);
    expect(node.broadcasts).toHaveLength(1);
  });

  it('refuses transactions that do not pay exactly what was asked', async () => {
    const { toll, node, pay, credential, seconds } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const other = wallet().address;
    const cases: [string, string][] = [
      ['transfer_mismatch', pay(challenge, { calls: (memo, amount) => [transfer(RECIPIENT, amount - 1n, memo)] })],
      ['transfer_mismatch', pay(challenge, { calls: (memo, amount) => [transfer(other, amount, memo)] })],
      ['transfer_mismatch', pay(challenge, { calls: (memo, amount) => [transfer(RECIPIENT, amount, memo, other)] })],
      ['transfer_mismatch', pay(challenge, { calls: (_memo, amount) => [transfer(RECIPIENT, amount)] })],
      ['transfer_mismatch', pay(challenge, { calls: (memo, amount) => [transfer(RECIPIENT, amount, memo), transfer(other, 1n)] })],
      ['transfer_mismatch', pay(challenge, { calls: (_memo, amount) => [transfer(RECIPIENT, amount, `0x${'ab'.repeat(32)}`)] })],
      ['chain_mismatch', pay(challenge, { chainId: 4217 })],
      ['valid_before_after_expiry', pay(challenge, { validBefore: seconds(10 * 60_000) })],
      ['transaction_expired', pay(challenge, { validBefore: seconds(-1_000) })],
      ['fee_payer_unsupported', pay(challenge, { feePayerMarker: true })],
    ];
    for (const [reason, signed] of cases) {
      expect(await get(gate, { authorization: credential(challenge, signed) })).toMatchObject({ status: 402, handlerRuns: 0, body: { reason } });
    }

    const signed = pay(challenge);
    const highS = signed.slice(0, -130) + flipS(signed.slice(-130));
    expect((await get(gate, { authorization: credential(challenge, highS) })).body.reason).toBe('signature_invalid');
    expect((await get(gate, { authorization: credential(challenge, '0x02f8') })).body.reason).toBe('transaction_malformed');
    expect((await get(gate, { authorization: authorization(challenge, { type: 'hash', hash: `0x${'11'.repeat(32)}` }) })).body.reason).toBe('mode_unsupported');
    expect(node.broadcasts).toHaveLength(0);
  });

  it('refuses a replayed credential', async () => {
    const { toll, node, pay, credential } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const proof = credential(challenge, pay(challenge));
    await get(gate, { authorization: proof });

    expect(await get(gate, { authorization: proof })).toMatchObject({ status: 402, body: { reason: 'proof_already_used' } });
    expect(node.broadcasts).toHaveLength(1);
  });

  it('refuses a transaction signed for another challenge', async () => {
    const { toll, pay, credential } = tempoSetup();
    const gate = toll.price('$0.01');
    const first = await challengeFor(gate);
    const second = await challengeFor(gate);

    expect((await get(gate, { authorization: credential(second, pay(first)) })).body.reason).toBe('transfer_mismatch');
  });

  it('pays split recipients in the same transaction', async () => {
    const { toll, pay, credential } = tempoSetup({ splits: (amount) => [{ recipient: PLATFORM, amount: amount / 10n }] });
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    expect(decodeJson(challenge.request ?? '').methodDetails).toMatchObject({ splits: [{ amount: '1000', recipient: PLATFORM }] });

    const unsplit = pay(challenge, { calls: (memo, amount) => [transfer(RECIPIENT, amount, memo)] });
    expect((await get(gate, { authorization: credential(challenge, unsplit) })).body.reason).toBe('transfer_mismatch');
    const split = pay(challenge, { calls: (memo) => [transfer(PLATFORM, 1_000n), transfer(RECIPIENT, 9_000n, memo)] });
    expect((await get(gate, { authorization: credential(challenge, split) })).status).toBe(200);
  });
});

describe('mppTempo settlement outcomes', () => {
  it('records a reverted transaction as a rejected settlement after the handler ran', async () => {
    const { toll, node, pay, credential, charges, errors } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    node.simulate({ send: 'revert' });
    const result = await get(gate, { authorization: credential(challenge, pay(challenge)) });

    expect(result.headers.get('payment-receipt')).toBeNull();
    expect(charges()).toEqual(['failed/completed']);
    expect(errors()).toMatchObject([{ code: 'SETTLEMENT_REJECTED' }]);
  });

  it('resolves a broadcast whose answer was lost: it happened', async () => {
    const { toll, node, pay, credential, charges, clock } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    node.simulate({ send: 'timeout-after-effect' });
    await get(gate, { authorization: credential(challenge, pay(challenge)) });
    expect(charges()).toEqual(['unknown/completed']);

    node.simulate({});
    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['settled/completed']);
    expect(node.broadcasts).toHaveLength(1);
  });

  it('resolves a broadcast that never reached the node: it did not happen, so it is sent again', async () => {
    const { toll, node, pay, credential, charges, clock } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const signed = pay(challenge);
    node.simulate({ send: 'down' });
    await get(gate, { authorization: credential(challenge, signed) });
    expect(charges()).toEqual(['unknown/completed']);

    node.simulate({});
    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['settled/completed']);
    expect(node.receipts.size).toBe(1);
  });

  it('keeps a refused broadcast unknown until the transaction expires, then records the failure', async () => {
    const { toll, node, pay, credential, charges, clock } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    node.simulate({ send: 'refuse' });
    await get(gate, { authorization: credential(challenge, pay(challenge)) });
    expect(charges()).toEqual(['unknown/completed']);

    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['unknown/completed']);

    clock.advance(3 * 60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['failed/completed']);
    expect(node.receipts.size).toBe(0);
  });
});

describe('mppTempo crash recovery', () => {
  it('releases a charge whose process crashed during the handler, without broadcasting', async () => {
    const { toll, node, pay, credential, charges, clock } = tempoSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const headers = { authorization: credential(challenge, pay(challenge)) };
    expect((await gate.enter(httpContext(new Request('https://api.example.com/report', { headers })))).kind).toBe('admitted');
    expect(charges()).toEqual(['reserved/running']);

    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['released/failed']);
    expect(node.broadcasts).toHaveLength(0);
  });
});

describe('mppTempo push mode', () => {
  it('accepts a transaction the payer already broadcast, bound to this challenge', async () => {
    const { toll, node, pay, charges } = tempoSetup({ modes: ['pull', 'push'] });
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    expect((decodeJson(challenge.request ?? '').methodDetails as Record<string, unknown>).supportedModes).toBeUndefined();

    const hash = node.include(pay(challenge));
    const result = await get(gate, { authorization: authorization(challenge, { type: 'hash', hash }) });
    expect(result.status).toBe(200);
    expect(decodeJson(result.headers.get('payment-receipt') ?? '').reference).toBe(hash);
    expect(charges()).toEqual(['settled/completed']);
    expect(node.broadcasts).toHaveLength(0);
  });

  it('refuses unknown, reverted, and unrelated transactions, and answers 503 when the node is down', async () => {
    const { toll, node, pay, seconds } = tempoSetup({ modes: ['push'] });
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);
    const other = await challengeFor(gate);
    const hashOf = (hash: string) => authorization(challenge, { type: 'hash', hash });

    expect((await get(gate, { authorization: hashOf(`0x${'11'.repeat(32)}`) })).body.reason).toBe('transaction_not_found');
    expect((await get(gate, { authorization: hashOf(node.include(pay(challenge, { validBefore: seconds(30_000) }), false)) })).body.reason).toBe('transaction_reverted');
    expect((await get(gate, { authorization: hashOf(node.include(pay(other))) })).body.reason).toBe('transfer_mismatch');

    node.simulate({ read: 'down' });
    expect(await get(gate, { authorization: hashOf(node.include(pay(challenge))) })).toMatchObject({ status: 503, handlerRuns: 0 });
  });
});

function flipS(signature: string): string {
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = signature.slice(0, 64);
  const s = BigInt(`0x${signature.slice(64, 128)}`);
  const v = Number.parseInt(signature.slice(128, 130), 16);
  return r + (n - s).toString(16).padStart(64, '0') + (v === 27 ? 28 : 27).toString(16);
}
