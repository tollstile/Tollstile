// Shared ledger conformance suite. Kept identical in @tollstile/postgres and @tollstile/sqlite (packages do
// not import each other); every case also runs against memoryLedger, the behavioral reference.
import { money, type Charge, type ChargePatch, type ChargeStates, type Clock, type Ledger, type NewAuthorization, type NewCharge } from 'tollstile';
import { fakeClock } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';

export type LedgerFactory = (clock: Clock) => Promise<Ledger>;

const usd = (micros: bigint) => money('USD', micros);
const state = (payment: ChargeStates['payment'], fulfillment: ChargeStates['fulfillment']): ChargeStates => ({ payment, fulfillment });
const INT64_MAX = 9_223_372_036_854_775_807n;

export function describeLedgerConformance(name: string, createLedger: LedgerFactory): void {
  async function setup() {
    const clock = fakeClock();
    const ledger = await createLedger(clock);

    const open = (input: Partial<NewAuthorization> = {}) =>
      ledger.openAuthorization({
        id: 'auth_1',
        rail: 'test',
        payer: 'payer_1',
        kind: 'single',
        limit: usd(10_000n),
        quoteId: null,
        expiresAt: null,
        data: { proofId: 'p1' },
        at: clock.now(),
        ...input,
      });

    const charge = (input: Partial<NewCharge> = {}) =>
      ledger.createCharge({
        id: 'chg_1',
        authorizationId: 'auth_1',
        requestId: 'req_1',
        resource: 'GET /weather',
        payer: 'payer_1',
        flow: 'authorization',
        amount: usd(10_000n),
        fulfillment: 'running',
        requestHash: null,
        at: clock.now(),
        ...input,
      });

    const created = async (input: Partial<NewCharge> = {}): Promise<Charge> => {
      const result = await charge(input);
      if (result.status !== 'created') throw new Error(`expected created, got ${result.status}`);
      return result.charge;
    };

    const move = async (current: Charge, to: ChargeStates, patch?: ChargePatch) => {
      clock.advance(1_000);
      const result = await ledger.transitionCharge(current.id, current, to, clock.now(), patch);
      if (result.status !== 'moved') throw new Error(`expected moved, got conflict for ${current.id}`);
      return result;
    };

    const totals = async (id = 'auth_1') => {
      const authorization = await ledger.getAuthorization(id);
      return { reserved: authorization?.reserved.micros, consumed: authorization?.consumed.micros };
    };

    return { clock, ledger, open, charge, created, move, totals };
  }

  describe(`${name}: ledger conformance`, () => {
    describe('openAuthorization', () => {
      it('inserts once and returns the stored authorization afterwards', async () => {
        const { ledger, open, clock } = await setup();
        const first = await open();

        expect(first).toEqual({
          created: true,
          authorization: {
            id: 'auth_1',
            rail: 'test',
            payer: 'payer_1',
            kind: 'single',
            limit: usd(10_000n),
            consumed: usd(0n),
            reserved: usd(0n),
            quoteId: null,
            expiresAt: null,
            data: { proofId: 'p1' },
            createdAt: clock.now(),
            updatedAt: clock.now(),
          },
        });

        clock.advance(5_000);
        const second = await open({ payer: 'someone_else', data: { proofId: 'other' }, at: clock.now() });
        expect(second).toEqual({ created: false, authorization: first.authorization });
        expect(await ledger.getAuthorization('auth_1')).toEqual(first.authorization);
      });

      it('returns undefined for unknown ids', async () => {
        const { ledger } = await setup();
        expect(await ledger.getAuthorization('missing')).toBeUndefined();
        expect(await ledger.getCharge('missing')).toBeUndefined();
      });

      it('keeps expiry, quote, and nested JSON data, and starts an unlimited authorization in USD', async () => {
        const { ledger, open, clock } = await setup();
        const expiresAt = new Date(clock.now().getTime() + 60_000);
        const data = { list: [1, 'two', null, true, { nested: 1.5 }], text: 'ünïcode ✓' };
        const { authorization } = await open({ kind: 'reusable', limit: null, quoteId: 'q_1', expiresAt, data });

        expect(authorization).toMatchObject({ limit: null, consumed: usd(0n), reserved: usd(0n), quoteId: 'q_1', expiresAt, data });
        expect(await ledger.getAuthorization('auth_1')).toEqual(authorization);
      });
    });

    describe('createCharge', () => {
      it('reserves the amount and returns the charge with the updated authorization', async () => {
        const { ledger, open, charge, clock } = await setup();
        await open();
        clock.advance(1_000);
        const result = await charge({ at: clock.now() });

        const expected: Charge = {
          id: 'chg_1',
          authorizationId: 'auth_1',
          requestId: 'req_1',
          resource: 'GET /weather',
          payer: 'payer_1',
          flow: 'authorization',
          reservedAmount: usd(10_000n),
          amount: usd(10_000n),
          payment: 'reserved',
          fulfillment: 'running',
          pending: null,
          settlement: null,
          refundReference: null,
          requestHash: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        };
        expect(result).toMatchObject({
          status: 'created',
          charge: expected,
          authorization: { reserved: usd(10_000n), consumed: usd(0n), updatedAt: clock.now() },
        });
        expect(await ledger.getCharge('chg_1')).toEqual(expected);
      });

      it('returns exists for a charge id that was already created, without reserving again', async () => {
        const { open, charge, created, totals } = await setup();
        await open({ kind: 'reusable', limit: usd(100_000n) });
        const first = await created();

        expect(await charge({ amount: usd(5_000n), requestId: 'req_other' })).toEqual({ status: 'exists', charge: first });
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });

      it('keeps the request hash on create, on exists, and through transitions', async () => {
        const { ledger, open, charge, created, move } = await setup();
        await open({ kind: 'reusable', limit: usd(100_000n) });

        const hashed = await created({ id: 'chg_hashed', requestHash: 'sha256:9f86d081884c7d65' });
        expect(hashed.requestHash).toBe('sha256:9f86d081884c7d65');
        expect(await charge({ id: 'chg_hashed', requestHash: 'sha256:other' })).toEqual({ status: 'exists', charge: hashed });

        const settling = await move(hashed, state('settling', 'completed'), { pending: 'settle', amount: usd(5_000n) });
        const settled = await move(settling.charge, state('settled', 'completed'), { pending: null, settlement: { reference: 's_1', details: {} } });
        expect(settled.charge.requestHash).toBe('sha256:9f86d081884c7d65');
        expect((await ledger.getCharge('chg_hashed'))?.requestHash).toBe('sha256:9f86d081884c7d65');

        const plain = await created({ id: 'chg_plain', requestHash: null });
        expect(plain.requestHash).toBeNull();
        expect(await charge({ id: 'chg_plain', requestHash: 'sha256:late' })).toEqual({ status: 'exists', charge: plain });
        const released = await move(plain, state('released', 'failed'), { pending: null });
        expect(released.charge.requestHash).toBeNull();
        expect((await ledger.getCharge('chg_plain'))?.requestHash).toBeNull();
      });

      it('returns exists for a charge id created under another authorization, and reserves nothing on this one', async () => {
        const { open, charge, created, totals } = await setup();
        await open({ id: 'auth_first', kind: 'reusable', limit: usd(100_000n) });
        await open({ id: 'auth_second', kind: 'reusable', limit: usd(100_000n) });
        const first = await created({ id: 'chg_keyed', authorizationId: 'auth_first', requestHash: 'sha256:abc' });

        expect(await charge({ id: 'chg_keyed', authorizationId: 'auth_second', requestHash: 'sha256:abc' })).toEqual({ status: 'exists', charge: first });
        expect(await totals('auth_first')).toEqual({ reserved: 10_000n, consumed: 0n });
        expect(await totals('auth_second')).toEqual({ reserved: 0n, consumed: 0n });
      });

      it('reserves once when the same charge id is created concurrently under two authorizations', async () => {
        const { open, charge, totals } = await setup();
        await open({ id: 'auth_first', kind: 'reusable', limit: usd(100_000n) });
        await open({ id: 'auth_second', kind: 'reusable', limit: usd(100_000n) });
        const results = await Promise.all([
          charge({ id: 'chg_keyed', authorizationId: 'auth_first' }),
          charge({ id: 'chg_keyed', authorizationId: 'auth_second' }),
        ]);

        expect(results.map((result) => result.status).sort()).toEqual(['created', 'exists']);
        const [first, second] = [await totals('auth_first'), await totals('auth_second')];
        expect([first.reserved, second.reserved].sort()).toEqual([0n, 10_000n]);
      });

      it('returns missing for an unknown authorization', async () => {
        const { charge } = await setup();
        expect(await charge()).toEqual({ status: 'missing' });
      });

      it('returns expired from the moment the authorization expires', async () => {
        const { open, charge, clock } = await setup();
        const start = clock.now().getTime();
        await open({ kind: 'reusable', limit: usd(100_000n), expiresAt: new Date(start + 1_000) });

        expect(await charge({ id: 'chg_1', at: new Date(start + 999) })).toMatchObject({ status: 'created' });
        expect(await charge({ id: 'chg_2', at: new Date(start + 1_000) })).toEqual({ status: 'expired' });
        expect(await charge({ id: 'chg_3', at: new Date(start + 5_000) })).toEqual({ status: 'expired' });
      });

      it('returns insufficient beyond the limit and accepts exactly the limit', async () => {
        const { open, charge, totals } = await setup();
        await open({ kind: 'reusable', limit: usd(25_000n) });

        expect((await charge({ id: 'chg_1' })).status).toBe('created');
        expect((await charge({ id: 'chg_2' })).status).toBe('created');
        expect((await charge({ id: 'chg_3' })).status).toBe('insufficient');
        expect((await charge({ id: 'chg_4', amount: usd(5_000n) })).status).toBe('created');
        expect((await charge({ id: 'chg_5', amount: usd(1n) })).status).toBe('insufficient');
        expect(await totals()).toEqual({ reserved: 25_000n, consumed: 0n });
      });

      it('single-use: busy while a charge is not released, free again once it is', async () => {
        const { open, charge, created, move } = await setup();
        await open();
        const first = await created({ id: 'chg_1' });

        expect(await charge({ id: 'chg_2' })).toEqual({ status: 'busy' });
        await move(first, state('released', 'failed'), { pending: null });

        const retry = await created({ id: 'chg_2' });
        const settling = await move(retry, state('settling', 'completed'), { pending: 'settle' });
        await move(settling.charge, state('settled', 'completed'), { pending: null });
        expect(await charge({ id: 'chg_3' })).toEqual({ status: 'busy' });
      });

      it('single-use: a failed settlement keeps the authorization busy', async () => {
        const { open, charge, created, move } = await setup();
        await open();
        const settling = await move(await created(), state('settling', 'completed'), { pending: 'settle' });
        await move(settling.charge, state('failed', 'completed'), { pending: null });

        expect(await charge({ id: 'chg_2' })).toEqual({ status: 'busy' });
      });

      it('reusable: counts committed and in-flight charges against the limit, and released capacity returns', async () => {
        const { open, charge, created, move, totals } = await setup();
        await open({ kind: 'reusable', limit: usd(20_000n) });
        const first = await created({ id: 'chg_1' });
        const second = await created({ id: 'chg_2' });
        expect((await charge({ id: 'chg_3' })).status).toBe('insufficient');

        await move(first, state('released', 'failed'), { pending: null });
        await created({ id: 'chg_3' });
        const settling = await move(second, state('settling', 'completed'), { pending: 'settle' });
        await move(settling.charge, state('settled', 'completed'), { pending: null });

        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 10_000n });
        expect((await charge({ id: 'chg_4', amount: usd(1n) })).status).toBe('insufficient');
      });

      it('an unlimited authorization adopts the charge currency while it is empty', async () => {
        const { ledger, open, created } = await setup();
        await open({ kind: 'reusable', limit: null });
        await created({ amount: money('EUR', 5_000n) });

        expect(await ledger.getAuthorization('auth_1')).toMatchObject({ reserved: money('EUR', 5_000n), consumed: money('EUR', 0n) });
      });

      it('concurrent charges on one single-use authorization: one wins', async () => {
        const { open, charge, totals } = await setup();
        await open();
        const results = await Promise.all(Array.from({ length: 10 }, (_, index) => charge({ id: `chg_${index}`, requestId: `req_${index}` })));

        const statuses = results.map((result) => result.status);
        expect(statuses.filter((status) => status === 'created')).toHaveLength(1);
        expect(statuses.filter((status) => status === 'busy')).toHaveLength(9);
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });

      it('concurrent charges on one reusable authorization never exceed its limit', async () => {
        const { open, charge, totals } = await setup();
        await open({ kind: 'reusable', limit: usd(30_000n) });
        const results = await Promise.all(Array.from({ length: 10 }, (_, index) => charge({ id: `chg_${index}`, requestId: `req_${index}` })));

        const statuses = results.map((result) => result.status);
        expect(statuses.filter((status) => status === 'created')).toHaveLength(3);
        expect(statuses.filter((status) => status === 'insufficient')).toHaveLength(7);
        expect(await totals()).toEqual({ reserved: 30_000n, consumed: 0n });
      });

      it('concurrent creation of the same charge id reserves once', async () => {
        const { open, charge, totals } = await setup();
        await open({ kind: 'reusable', limit: usd(100_000n) });
        const results = await Promise.all([charge(), charge(), charge()]);

        expect(results.map((result) => result.status).sort()).toEqual(['created', 'exists', 'exists']);
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });
    });

    describe('transitionCharge', () => {
      it('compares and sets the payment axis', async () => {
        const { ledger, open, created, clock, totals } = await setup();
        await open();
        const current = await created();

        const result = await ledger.transitionCharge('chg_1', state('settling', 'running'), state('settled', 'running'), clock.now());
        expect(result).toEqual({ status: 'conflict', charge: current });
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });

      it('compares and sets the fulfillment axis', async () => {
        const { ledger, open, created, clock, totals } = await setup();
        await open();
        const current = await created();

        const result = await ledger.transitionCharge('chg_1', state('reserved', 'completed'), state('released', 'completed'), clock.now());
        expect(result).toEqual({ status: 'conflict', charge: current });
        expect(await ledger.getCharge('chg_1')).toEqual(current);
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });

      it('conflicts with no charge for an unknown id', async () => {
        const { ledger, clock } = await setup();
        const result = await ledger.transitionCharge('missing', state('reserved', 'running'), state('released', 'failed'), clock.now());
        expect(result).toEqual({ status: 'conflict', charge: undefined });
      });

      it('lets one of two identical concurrent transitions through', async () => {
        const { ledger, open, created, clock, totals } = await setup();
        await open();
        await created();
        const from = state('reserved', 'running');
        const to = state('settling', 'completed');
        const results = await Promise.all([
          ledger.transitionCharge('chg_1', from, to, clock.now(), { pending: 'settle' }),
          ledger.transitionCharge('chg_1', from, to, clock.now(), { pending: 'settle' }),
        ]);

        expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'moved']);
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });

      it('accounts reserved → settling → settled → refund_pending → unknown (refund) → refunded', async () => {
        const { open, created, move } = await setup();
        await open();
        const steps: { to: ChargeStates; patch: ChargePatch; reserved: bigint; consumed: bigint }[] = [
          { to: state('settling', 'completed'), patch: { pending: 'settle' }, reserved: 10_000n, consumed: 0n },
          { to: state('settled', 'completed'), patch: { pending: null, settlement: { reference: 's_1', details: {} } }, reserved: 0n, consumed: 10_000n },
          { to: state('refund_pending', 'completed'), patch: { pending: 'refund' }, reserved: 0n, consumed: 10_000n },
          { to: state('unknown', 'completed'), patch: {}, reserved: 0n, consumed: 10_000n },
          { to: state('refunded', 'completed'), patch: { pending: null, refundReference: 'r_1' }, reserved: 0n, consumed: 0n },
        ];

        let current = await created();
        for (const step of steps) {
          const result = await move(current, step.to, step.patch);
          expect(result.authorization).toMatchObject({ reserved: usd(step.reserved), consumed: usd(step.consumed), updatedAt: result.charge.updatedAt });
          current = result.charge;
        }
      });

      it('accounts unknown (settle) as reserved until it resolves to settled or released', async () => {
        const { open, created, move } = await setup();
        await open({ kind: 'reusable', limit: usd(100_000n) });

        const toSettle = await move(await created({ id: 'chg_1' }), state('settling', 'completed'), { pending: 'settle' });
        const unknown = await move(toSettle.charge, state('unknown', 'completed'));
        expect(unknown.charge.pending).toBe('settle');
        expect(unknown.authorization).toMatchObject({ reserved: usd(10_000n), consumed: usd(0n) });
        const settled = await move(unknown.charge, state('settled', 'completed'), { pending: null });
        expect(settled.authorization).toMatchObject({ reserved: usd(0n), consumed: usd(10_000n) });

        const toRelease = await move(await created({ id: 'chg_2' }), state('settling', 'running'), { pending: 'settle' });
        const unresolved = await move(toRelease.charge, state('unknown', 'running'));
        expect(unresolved.authorization).toMatchObject({ reserved: usd(10_000n), consumed: usd(10_000n) });
        const released = await move(unresolved.charge, state('released', 'failed'), { pending: null });
        expect(released.authorization).toMatchObject({ reserved: usd(0n), consumed: usd(10_000n) });
      });

      it('classifies an unknown charge by the pending operation its patch sets', async () => {
        const { open, created, move } = await setup();
        await open();
        const settling = await move(await created(), state('settling', 'completed'), { pending: 'settle' });
        const unknown = await move(settling.charge, state('unknown', 'completed'));

        const refunding = await move(unknown.charge, state('unknown', 'completed'), { pending: 'refund' });
        expect(refunding.authorization).toMatchObject({ reserved: usd(0n), consumed: usd(10_000n) });
        const settlingAgain = await move(refunding.charge, state('unknown', 'completed'), { pending: 'settle' });
        expect(settlingAgain.authorization).toMatchObject({ reserved: usd(10_000n), consumed: usd(0n) });
      });

      it('returns the reservation when a charge is released', async () => {
        const { open, created, move } = await setup();
        await open();
        const released = await move(await created(), state('released', 'failed'), { pending: null });

        expect(released.charge).toMatchObject({ payment: 'released', fulfillment: 'failed' });
        expect(released.authorization).toMatchObject({ reserved: usd(0n), consumed: usd(0n) });
      });

      it('settles a patched variable amount and frees the whole reservation', async () => {
        const { open, created, move } = await setup();
        await open({ kind: 'reusable', limit: usd(100_000n) });

        const settling = await move(await created(), state('settling', 'completed'), { pending: 'settle', amount: usd(6_000n) });
        expect(settling.charge).toMatchObject({ reservedAmount: usd(10_000n), amount: usd(6_000n) });
        expect(settling.authorization).toMatchObject({ reserved: usd(10_000n), consumed: usd(0n) });

        const settled = await move(settling.charge, state('settled', 'completed'), { pending: null });
        expect(settled.authorization).toMatchObject({ reserved: usd(0n), consumed: usd(6_000n) });
      });

      it('applies patches: pending is kept when omitted and cleared with null; references stay once set', async () => {
        const { ledger, open, created, move } = await setup();
        await open();
        const createdCharge = await created();

        const completed = await move(createdCharge, state('reserved', 'completed'));
        expect(completed.charge).toMatchObject({ pending: null, settlement: null, refundReference: null });

        const settling = await move(completed.charge, state('settling', 'completed'), { pending: 'settle' });
        const unknown = await move(settling.charge, state('unknown', 'completed'), {});
        expect(unknown.charge.pending).toBe('settle');

        const settlement = { reference: 's_1', details: { tx: '0xabc', confirmations: [1, 2], final: true } };
        const settled = await move(unknown.charge, state('settled', 'completed'), { pending: null, settlement });
        expect(settled.charge).toMatchObject({ pending: null, settlement });

        const refundPending = await move(settled.charge, state('refund_pending', 'completed'), { pending: 'refund' });
        expect(refundPending.charge).toMatchObject({ pending: 'refund', settlement });

        const refunded = await move(refundPending.charge, state('refunded', 'completed'), { pending: null, refundReference: 'r_1' });
        expect(refunded.charge).toEqual({
          ...createdCharge,
          payment: 'refunded',
          fulfillment: 'completed',
          pending: null,
          settlement,
          refundReference: 'r_1',
          updatedAt: refunded.charge.updatedAt,
        });
        expect(refunded.charge.updatedAt.getTime()).toBeGreaterThan(createdCharge.createdAt.getTime());
        expect(await ledger.getCharge('chg_1')).toEqual(refunded.charge);
      });

      it('stores settlement details that are JSON null', async () => {
        const { ledger, open, created, move } = await setup();
        await open();
        const settling = await move(await created(), state('settling', 'completed'), { pending: 'settle' });
        await move(settling.charge, state('settled', 'completed'), { pending: null, settlement: { reference: 's_1', details: null } });

        expect((await ledger.getCharge('chg_1'))?.settlement).toEqual({ reference: 's_1', details: null });
      });
    });

    describe('replaceAuthorizationData', () => {
      it('replaces the data and updatedAt, and keeps everything else', async () => {
        const { ledger, open, created, clock } = await setup();
        await open({ data: { proofId: 'p1', signature: '0xsig' } });
        const opened = await ledger.getAuthorization('auth_1');
        await created();
        const afterCharge = await ledger.getAuthorization('auth_1');

        clock.advance(1_000);
        await expect(ledger.replaceAuthorizationData('auth_1', { proofId: 'p1' }, clock.now())).resolves.toBeUndefined();

        expect(await ledger.getAuthorization('auth_1')).toEqual({ ...afterCharge, data: { proofId: 'p1' }, updatedAt: clock.now() });
        expect(opened?.createdAt).toEqual((await ledger.getAuthorization('auth_1'))?.createdAt);
        await ledger.replaceAuthorizationData('auth_1', null, clock.now());
        expect((await ledger.getAuthorization('auth_1'))?.data).toBeNull();
      });

      it('does nothing for an unknown authorization', async () => {
        const { ledger, clock } = await setup();
        await expect(ledger.replaceAuthorizationData('missing', { a: 1 }, clock.now())).resolves.toBeUndefined();
        expect(await ledger.getAuthorization('missing')).toBeUndefined();
      });
    });

    describe('currencies and storable amounts', () => {
      it('refuses a charge in another currency than the authorization limit, and reserves nothing', async () => {
        const { ledger, open, charge, totals } = await setup();
        await open();

        await expect(charge({ amount: money('EUR', 1_000n) })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
        expect(await ledger.getCharge('chg_1')).toBeUndefined();
        expect(await totals()).toEqual({ reserved: 0n, consumed: 0n });
      });

      it('holds an unlimited authorization to the currency it has reserved or consumed', async () => {
        const { ledger, open, charge, created, move } = await setup();
        await open({ kind: 'reusable', limit: null });

        const first = await created({ id: 'chg_1', amount: money('EUR', 5_000n) });
        await expect(charge({ id: 'chg_2', amount: usd(5_000n) })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });

        const settling = await move(first, state('settling', 'completed'), { pending: 'settle' });
        await move(settling.charge, state('settled', 'completed'), { pending: null });
        await expect(charge({ id: 'chg_2', amount: usd(5_000n) })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
        expect((await charge({ id: 'chg_3', amount: money('EUR', 1_000n) })).status).toBe('created');
        expect(await ledger.getAuthorization('auth_1')).toMatchObject({ reserved: money('EUR', 1_000n), consumed: money('EUR', 5_000n) });
      });

      it('lets an unlimited authorization change currency once everything on it was released', async () => {
        const { ledger, open, created, move } = await setup();
        await open({ kind: 'reusable', limit: null });
        await move(await created({ id: 'chg_1', amount: money('EUR', 5_000n) }), state('released', 'failed'), { pending: null });

        await created({ id: 'chg_2', amount: usd(2_000n) });
        expect(await ledger.getAuthorization('auth_1')).toMatchObject({ reserved: usd(2_000n), consumed: usd(0n) });
      });

      it('refuses amounts outside 0 to 2^63 - 1, and writes nothing', async () => {
        const { ledger, open, charge, totals } = await setup();
        await open({ kind: 'reusable', limit: null });

        await expect(charge({ amount: usd(INT64_MAX + 1n) })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        await expect(charge({ amount: usd(-1n) })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        expect(await ledger.getCharge('chg_1')).toBeUndefined();
        expect(await totals()).toEqual({ reserved: 0n, consumed: 0n });
      });

      it('reports exists, missing, and expired before refusing an amount', async () => {
        const { open, charge, created, clock } = await setup();
        expect(await charge({ amount: usd(-1n) })).toEqual({ status: 'missing' });

        await open({ kind: 'reusable', limit: usd(100_000n), expiresAt: new Date(clock.now().getTime() + 1_000) });
        const first = await created();
        expect(await charge({ amount: money('EUR', -1n) })).toEqual({ status: 'exists', charge: first });
        expect(await charge({ id: 'chg_2', amount: money('EUR', 1n), at: new Date(clock.now().getTime() + 1_000) })).toEqual({ status: 'expired' });
      });

      it('refuses a patched amount in another currency or out of range, and moves nothing', async () => {
        const { ledger, open, created, clock, totals } = await setup();
        await open();
        const current = await created();
        const from = state('reserved', 'running');
        const to = state('settling', 'completed');

        await expect(ledger.transitionCharge('chg_1', from, to, clock.now(), { amount: money('EUR', 1_000n) })).rejects.toMatchObject({
          code: 'CURRENCY_MISMATCH',
        });
        await expect(ledger.transitionCharge('chg_1', from, to, clock.now(), { amount: usd(INT64_MAX + 1n) })).rejects.toMatchObject({
          code: 'INVALID_AMOUNT',
        });
        expect(await ledger.getCharge('chg_1')).toEqual(current);
        expect(await totals()).toEqual({ reserved: 10_000n, consumed: 0n });
      });

      it('reports a conflict before refusing a patched amount', async () => {
        const { ledger, open, created, clock } = await setup();
        await open();
        const current = await created();

        const result = await ledger.transitionCharge('chg_1', state('settling', 'completed'), state('settled', 'completed'), clock.now(), {
          amount: money('EUR', -1n),
        });
        expect(result).toEqual({ status: 'conflict', charge: current });
      });
    });

    describe('pendingCharges', () => {
      it('returns charges that are not terminal and were last updated before the cutoff', async () => {
        const { ledger, open, created, move, clock } = await setup();
        await open({ kind: 'reusable', limit: null });
        const make = (id: string) => created({ id, requestId: id });

        await make('running');
        const unknown = await move(await make('unknown'), state('settling', 'completed'), { pending: 'settle' });
        await move(unknown.charge, state('unknown', 'completed'));
        const settledRunning = await move(await make('settled_running'), state('settling', 'pending'), { pending: 'settle' });
        await move(settledRunning.charge, state('settled', 'pending'), { pending: null });
        const settledCompleted = await move(await make('settled_completed'), state('settling', 'completed'), { pending: 'settle' });
        await move(settledCompleted.charge, state('settled', 'completed'), { pending: null });
        const refundPending = await move(await make('refund_pending'), state('settling', 'pending'), { pending: 'settle' });
        const settledForRefund = await move(refundPending.charge, state('settled', 'failed'), { pending: null });
        await move(settledForRefund.charge, state('refund_pending', 'failed'), { pending: 'refund' });
        await move(await make('released'), state('released', 'failed'), { pending: null });
        const failed = await move(await make('failed'), state('settling', 'completed'), { pending: 'settle' });
        await move(failed.charge, state('failed', 'completed'), { pending: null });

        clock.advance(1_000);
        const cutoff = clock.now();
        await created({ id: 'at_cutoff', requestId: 'at_cutoff', at: cutoff });

        const pending = await ledger.pendingCharges(cutoff);
        expect(pending.map((charge) => charge.id).sort()).toEqual(['refund_pending', 'running', 'settled_running', 'unknown']);
        expect(pending.find((charge) => charge.id === 'unknown')).toEqual(await ledger.getCharge('unknown'));
        expect((await ledger.pendingCharges(new Date(cutoff.getTime() + 1))).map((charge) => charge.id)).toContain('at_cutoff');
        expect(await ledger.pendingCharges(new Date(0))).toEqual([]);
      });
    });

    describe('spendSince', () => {
      it('counts and totals per currency, excluding released, failed, and refunded charges', async () => {
        const { ledger, open, created, move, clock } = await setup();
        await open({ id: 'auth_usd', kind: 'reusable', limit: null });
        await open({ id: 'auth_eur', kind: 'reusable', limit: null });
        await open({ id: 'auth_other', kind: 'reusable', limit: null, payer: 'payer_2' });
        const usdCharge = (id: string, micros: bigint, at = clock.now()) =>
          created({ id, requestId: id, authorizationId: 'auth_usd', amount: usd(micros), at });

        await usdCharge('before_window', 1_000n);
        clock.advance(1_000);
        const since = clock.now();
        await usdCharge('at_since', 10_000n, since);
        const settling = await move(await usdCharge('settled', 20_000n), state('settling', 'completed'), { pending: 'settle' });
        await move(settling.charge, state('settled', 'completed'), { pending: null });
        await created({ id: 'eur', requestId: 'eur', authorizationId: 'auth_eur', amount: money('EUR', 5_000n), at: clock.now() });
        await move(await usdCharge('released', 40_000n), state('released', 'failed'), { pending: null });
        const failing = await move(await usdCharge('failed', 80_000n), state('settling', 'completed'), { pending: 'settle' });
        await move(failing.charge, state('failed', 'completed'), { pending: null });
        const refunding = await move(await usdCharge('refunded', 160_000n), state('settling', 'completed'), { pending: 'settle' });
        const refundPending = await move(refunding.charge, state('refund_pending', 'completed'), { pending: 'refund' });
        await move(refundPending.charge, state('refunded', 'completed'), { pending: null });
        await created({ id: 'other', requestId: 'other', authorizationId: 'auth_other', payer: 'payer_2', amount: usd(320_000n), at: clock.now() });

        expect(await ledger.spendSince('payer_1', since)).toEqual({ count: 3, total: [money('EUR', 5_000n), usd(30_000n)] });
        expect(await ledger.spendSince('payer_2', since)).toEqual({ count: 1, total: [usd(320_000n)] });
        expect(await ledger.spendSince('nobody', since)).toEqual({ count: 0, total: [] });
      });
    });

    describe('claim', () => {
      it('claims a key once per scope until it expires', async () => {
        const { ledger, clock } = await setup();
        const expiresAt = new Date(clock.now().getTime() + 60_000);

        expect(await ledger.claim('nonce', 'n_1', expiresAt)).toBe('claimed');
        expect(await ledger.claim('nonce', 'n_1', expiresAt)).toBe('exists');
        expect(await ledger.claim('other-scope', 'n_1', expiresAt)).toBe('claimed');
        expect(await ledger.claim('nonce', 'n_2', expiresAt)).toBe('claimed');

        clock.advance(59_999);
        expect(await ledger.claim('nonce', 'n_1', expiresAt)).toBe('exists');
        clock.advance(1);
        expect(await ledger.claim('nonce', 'n_1', new Date(clock.now().getTime() + 10_000))).toBe('claimed');
        expect(await ledger.claim('nonce', 'n_1', new Date(clock.now().getTime() + 10_000))).toBe('exists');
      });

      it('lets one of several concurrent claims of the same key win', async () => {
        const { ledger, clock } = await setup();
        const expiresAt = new Date(clock.now().getTime() + 60_000);
        const results = await Promise.all(Array.from({ length: 5 }, () => ledger.claim('nonce', 'n_1', expiresAt)));

        expect(results.sort()).toEqual(['claimed', 'exists', 'exists', 'exists', 'exists']);
      });
    });

    describe('amounts', () => {
      it('round-trips amounts beyond 2^53 exactly', async () => {
        const { ledger, open, charge, created, move, clock } = await setup();
        const large = 9_007_199_254_740_993n;
        await open({ kind: 'reusable', limit: usd(INT64_MAX) });

        const first = await created({ id: 'chg_1', amount: usd(large) });
        expect(first.amount.micros).toBe(large);
        expect((await ledger.getCharge('chg_1'))?.reservedAmount.micros).toBe(large);

        const settling = await move(first, state('settling', 'completed'), { pending: 'settle' });
        const settled = await move(settling.charge, state('settled', 'completed'), { pending: null });
        expect(settled.authorization.consumed.micros).toBe(large);

        const rest = await charge({ id: 'chg_2', amount: usd(INT64_MAX - large), at: clock.now() });
        expect(rest).toMatchObject({ status: 'created', authorization: { reserved: usd(INT64_MAX - large), consumed: usd(large) } });
        expect((await charge({ id: 'chg_3', amount: usd(1n) })).status).toBe('insufficient');
        expect((await ledger.getAuthorization('auth_1'))?.limit).toEqual(usd(INT64_MAX));
        expect(await ledger.spendSince('payer_1', new Date(0))).toEqual({ count: 2, total: [usd(INT64_MAX)] });
      });
    });
  });
}
