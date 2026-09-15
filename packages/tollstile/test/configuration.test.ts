import { describe, expect, it } from 'vitest';
import { createTollstile, memoryLedger, testRail, type Rail } from '../src/index';
import { mcpContext } from '../src/testing/index';
import { call, setup } from './helpers';

const withCapabilities = (overrides: Partial<Rail['capabilities']>): Rail => {
  const rail = testRail();
  return { ...rail, capabilities: { ...rail.capabilities, ...overrides } };
};

describe('configuration', () => {
  it('rejects invalid prices where routes are defined', () => {
    const { toll } = setup();
    expect(() => toll.price('0.01')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => toll.price('$0')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('refuses rails that cannot look up charges', () => {
    const toll = createTollstile({ rails: [withCapabilities({ lookup: false })], ledger: memoryLedger() });
    expect(() => toll.price('$0.01')).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISSING' }));
  });

  it('refuses the upfront flow on rails that cannot refund', () => {
    const toll = createTollstile({ rails: [withCapabilities({ refund: false })], ledger: memoryLedger() });
    expect(() => toll.price('$0.01', { flow: 'upfront' })).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISSING' }));
    expect(() => toll.price('$0.01')).not.toThrow();
  });

  it('refuses dynamic prices on rails that cannot carry quotes', () => {
    const toll = createTollstile({ rails: [withCapabilities({ quotes: false })], ledger: memoryLedger() });
    expect(() => toll.price(() => '$0.01')).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISSING' }));
  });

  it('says plainly that escrow is not implemented yet', () => {
    const { toll } = setup();
    expect(() => toll.price('$0.01', { flow: 'escrow' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('refuses duplicate rails, reserved names, and mixing test with live rails', () => {
    expect(() => createTollstile({ rails: [testRail(), testRail()], ledger: memoryLedger() })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() => createTollstile({ rails: [{ ...testRail(), name: 'policy:x' }], ledger: memoryLedger() })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() =>
      createTollstile({ rails: [testRail(), { ...testRail(), name: 'live', livemode: true }], ledger: memoryLedger(), secret: 's'.repeat(32) }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});

describe('events', () => {
  it('emits typed events across the lifecycle', async () => {
    const { toll, events } = setup();
    const gate = toll.price('$0.01');
    await call(gate);
    await call(gate, { payment: 'test proof=p1' });

    expect(events.map((event) => event.type)).toEqual([
      'quote.issued',
      'request.denied',
      'authorization.opened',
      'charge.moved',
      'charge.moved',
    ]);
  });
});

describe('mcp context', () => {
  it('reads the proof from _meta and returns the receipt as meta', async () => {
    const { toll } = setup();
    const entry = await toll
      .price('$0.01', { resource: 'tool:weather' })
      .enter(mcpContext('weather', { 'tollstile/test-payment': 'test proof=p1' }));
    if (entry.kind !== 'admitted') throw new Error('expected admission');

    const receipt = await entry.pass.complete('succeeded');
    expect(receipt.headers).toEqual([]);
    expect(Object.keys(receipt.meta)).toEqual(['tollstile/test-receipt']);
  });

  it('includes each rail’s MCP challenge in the denial', async () => {
    const { toll } = setup();
    const entry = await toll.price('$0.01', { resource: 'tool:weather' }).enter(mcpContext('weather', {}));
    if (entry.kind !== 'denied') throw new Error('expected denial');

    expect(entry.denial.status).toBe(402);
    expect(entry.denial.offers[0]?.challenge.mcp).toMatchObject({ style: 'tollstile', meta: 'tollstile/test-payment' });
  });
});
