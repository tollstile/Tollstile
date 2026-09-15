import { describe, expect, it } from 'vitest';
import { money, toResponse } from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { mppTempoSession, tempoSessionClose, type MppTempoSessionOptions } from '../src/index';
import { toHex } from '../src/encoding';
import { selector, ZERO_ADDRESS } from '../src/evm';
import { channelId, voucherDigest, TEMPO_CHANNEL_ESCROW, type ChannelDescriptor } from '../src/tempo-channel';
import { authorization, challengeFor, decodeJson, get, parseChallenges, setup, type WireChallenge } from './mpp-client';
import { CHAIN_ID, RECIPIENT, TOKEN, fakeTempo, sign, wallet, type Wallet } from './fake-tempo';

const SECRET = 'mpp-challenge-secret-0123456789abcdef';
const random32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

function sessionSetup(deposit = 50_000n, overrides: Partial<MppTempoSessionOptions> = {}) {
  const node = fakeTempo();
  const clock = fakeClock();
  const rail = mppTempoSession({
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
  const descriptor: ChannelDescriptor = {
    payer: payer.address,
    payee: RECIPIENT,
    operator: ZERO_ADDRESS,
    token: TOKEN,
    salt: random32(),
    authorizedSigner: ZERO_ADDRESS,
    expiringNonceHash: random32(),
  };
  const channel = channelId(descriptor, TEMPO_CHANNEL_ESCROW, CHAIN_ID);
  node.channels.set(channel, { settled: 0n, deposit, closeRequestedAt: 0n });

  const voucher = (challenge: WireChallenge, cumulative: bigint, change: { signer?: Wallet; descriptor?: ChannelDescriptor; channel?: string } = {}) =>
    authorization(challenge, {
      action: 'voucher',
      channelId: change.channel ?? channel,
      descriptor: change.descriptor ?? descriptor,
      cumulativeAmount: cumulative.toString(),
      signature: toHex(sign(voucherDigest(TEMPO_CHANNEL_ESCROW, CHAIN_ID, channel, cumulative), (change.signer ?? payer).secretKey)),
    });
  return { node, rail, payer, descriptor, channel, voucher, ...setup(rail, clock) };
}

describe('mppTempoSession challenge', () => {
  it('asks for a v2 session voucher on the channel escrow and settles before the handler', async () => {
    const { toll } = sessionSetup();
    const gate = toll.price('$0.01');
    const result = await get(gate);
    const [challenge] = parseChallenges(result.headers);

    expect(challenge).toMatchObject({ method: 'tempo', intent: 'session' });
    expect(decodeJson(challenge?.request ?? '')).toEqual({
      amount: '10000',
      unitType: 'request',
      currency: TOKEN,
      recipient: RECIPIENT,
      methodDetails: { chainId: CHAIN_ID, escrowContract: TEMPO_CHANNEL_ESCROW, sessionProtocol: 'v2' },
    });
    expect(result.body.accepts).toMatchObject([{ rail: 'mpp-tempo-session', flow: 'upfront' }]);
  });
});

describe('mppTempoSession charges', () => {
  it('charges many calls against one channel while vouchers cover consumption', async () => {
    const { toll, voucher, ledger, charges, channel } = sessionSetup();
    const gate = toll.price('$0.01');

    const first = await get(gate, { authorization: voucher(await challengeFor(gate), 10_000n) });
    const second = await get(gate, { authorization: voucher(await challengeFor(gate), 20_000n) });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(charges()).toEqual(['settled/completed', 'settled/completed']);
    expect(ledger.authorizations()).toHaveLength(1);
    expect(ledger.authorizations()[0]).toMatchObject({ kind: 'reusable', limit: money('USD', 50_000n), consumed: money('USD', 20_000n), expiresAt: null });
    expect(decodeJson(second.headers.get('payment-receipt') ?? '')).toMatchObject({
      method: 'tempo',
      intent: 'session',
      reference: channel,
      channelId: channel,
      acceptedCumulative: '20000',
      spent: '20000',
    });
  });

  it('refuses a voucher that does not cover consumption, including a replayed one', async () => {
    const { toll, voucher, charges } = sessionSetup();
    const gate = toll.price('$0.01');
    const proof = voucher(await challengeFor(gate), 10_000n);
    await get(gate, { authorization: proof });

    const replay = await get(gate, { authorization: proof });
    expect(replay).toMatchObject({ status: 402, handlerRuns: 0, body: { reason: 'payment_rejected' } });
    expect(charges()).toEqual(['settled/completed', 'failed/pending']);
  });

  it('refuses calls beyond the channel deposit', async () => {
    const { toll, voucher } = sessionSetup(20_000n);
    const gate = toll.price('$0.01');
    await get(gate, { authorization: voucher(await challengeFor(gate), 10_000n) });
    await get(gate, { authorization: voucher(await challengeFor(gate), 20_000n) });

    expect((await get(gate, { authorization: voucher(await challengeFor(gate), 20_000n) })).body.reason).toBe('insufficient_authorization');
    expect((await get(gate, { authorization: voucher(await challengeFor(gate), 30_000n) })).body.reason).toBe('amount_exceeds_deposit');
  });

  it('refunds a failed call by not counting it, so the next voucher need not cover it', async () => {
    const { toll, voucher, charges, ledger } = sessionSetup();
    const gate = toll.price('$0.01');
    await get(gate, { authorization: voucher(await challengeFor(gate), 10_000n), outcome: 'failed' });
    expect(charges()).toEqual(['refunded/failed']);

    expect((await get(gate, { authorization: voucher(await challengeFor(gate), 10_000n) })).status).toBe(200);
    expect(ledger.authorizations()[0]?.consumed).toEqual(money('USD', 10_000n));
  });

  it('never lets concurrent calls share one voucher’s value', async () => {
    const { toll, voucher, ledger } = sessionSetup();
    const gate = toll.price('$0.01');
    const [a, b] = [await challengeFor(gate), await challengeFor(gate)];
    const enter = (challenge: WireChallenge) =>
      gate.enter(httpContext(new Request('https://api.example.com/report', { headers: { authorization: voucher(challenge, 10_000n) } })));
    const entries = await Promise.all([enter(a), enter(b)]);
    for (const entry of entries) if (entry.kind === 'admitted') await entry.pass.complete('succeeded');

    expect(entries.filter((entry) => entry.kind === 'admitted').length).toBeLessThanOrEqual(1);
    expect(ledger.authorizations()[0]?.consumed.micros).toBeLessThanOrEqual(10_000n);
    const denied = entries.find((entry) => entry.kind === 'denied');
    if (denied?.kind === 'denied') expect(toResponse(denied.denial).status).toBe(402);
  });
});

describe('mppTempoSession verification failures', () => {
  it('refuses vouchers that are not the channel payer’s, or not for this payee', async () => {
    const { toll, voucher, descriptor, channel } = sessionSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);

    expect((await get(gate, { authorization: voucher(challenge, 10_000n, { signer: wallet() }) })).body.reason).toBe('signature_invalid');
    expect((await get(gate, { authorization: voucher(challenge, 10_000n, { descriptor: { ...descriptor, payee: wallet().address } }) })).body.reason).toBe('channel_terms_mismatch');
    expect((await get(gate, { authorization: voucher(challenge, 10_000n, { descriptor: { ...descriptor, salt: random32() } }) })).body.reason).toBe('channel_id_mismatch');
    expect((await get(gate, { authorization: voucher(challenge, 10_000n, { channel: `${channel.slice(0, -1)}0` }) })).body.reason).toMatch(/channel_id_mismatch|signature_invalid/);
    expect((await get(gate, { authorization: authorization(challenge, { action: 'open', type: 'transaction' }) })).body.reason).toBe('session_action_unsupported');
  });

  it('refuses channels that are unknown or closing, and answers 503 when the node is down', async () => {
    const { toll, voucher, node, channel } = sessionSetup();
    const gate = toll.price('$0.01');
    const challenge = await challengeFor(gate);

    node.channels.set(channel, { settled: 0n, deposit: 50_000n, closeRequestedAt: 1_767_225_600n });
    expect((await get(gate, { authorization: voucher(challenge, 10_000n) })).body.reason).toBe('channel_closing');
    node.channels.delete(channel);
    expect((await get(gate, { authorization: voucher(challenge, 10_000n) })).body.reason).toBe('channel_not_found');
    node.simulate({ read: 'down' });
    expect(await get(gate, { authorization: voucher(challenge, 10_000n) })).toMatchObject({ status: 503, handlerRuns: 0 });
  });

  it('counts consumption from the channel’s on-chain settled amount when first seen', async () => {
    const { toll, voucher, node, channel, ledger } = sessionSetup();
    node.channels.set(channel, { settled: 30_000n, deposit: 50_000n, closeRequestedAt: 0n });
    const gate = toll.price('$0.01');

    expect((await get(gate, { authorization: voucher(await challengeFor(gate), 10_000n) })).body.reason).toBe('voucher_below_settled');
    expect((await get(gate, { authorization: voucher(await challengeFor(gate), 30_000n) })).body.reason).toBe('payment_rejected');
    expect((await get(gate, { authorization: voucher(await challengeFor(gate), 40_000n) })).status).toBe(200);
    expect(ledger.authorizations()[0]?.limit).toEqual(money('USD', 20_000n));
  });
});

describe('tempoSessionClose', () => {
  it('captures what the ledger consumed, not the full voucher', async () => {
    const { toll, voucher, ledger, descriptor, channel } = sessionSetup();
    const gate = toll.price('$0.01');
    await get(gate, { authorization: voucher(await challengeFor(gate), 10_000n) });
    await get(gate, { authorization: voucher(await challengeFor(gate), 30_000n), outcome: 'failed' });
    await get(gate, { authorization: voucher(await challengeFor(gate), 40_000n) });

    const [auth] = ledger.authorizations();
    if (auth === undefined) throw new Error('expected an authorization');
    const close = tempoSessionClose({ authorization: auth, charges: ledger.charges() });

    expect(close).toMatchObject({ channelId: channel, to: TEMPO_CHANNEL_ESCROW, captureAmount: 20_000n, cumulativeAmount: 40_000n });
    expect(close.data.startsWith(selector('close((address,address,address,address,bytes32,address,bytes32),uint96,uint96,bytes)'))).toBe(true);
    expect(close.data.slice(10, 74)).toBe(`000000000000000000000000${descriptor.payer.slice(2)}`);
    expect(BigInt(`0x${close.data.slice(10 + 64 * 8, 10 + 64 * 9)}`)).toBe(20_000n);
    expect(tempoSessionClose({ authorization: auth, charges: ledger.charges(), settledOnChain: 25_000n }).captureAmount).toBe(25_000n);
    expect(() => tempoSessionClose({ authorization: auth, charges: [] })).toThrow(/No voucher/);
  });
});
