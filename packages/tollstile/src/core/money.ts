import { TollstileError } from './errors';

/**
 * An exact amount of a currency in millionths of its major unit. `$0.04` is
 * `{ currency: "USD", micros: 40000n }`. Six decimal places cover sub-cent prices and 6-decimal
 * stablecoins; amounts are never floats.
 */
export type Money = {
  readonly currency: string;
  readonly micros: bigint;
};

const MICROS = 1_000_000n;
const SYMBOLS: Readonly<Record<string, string>> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const SYMBOL_FORM = /^([$€£¥])(\d{1,12})(?:\.(\d{1,6}))?$/;
const CODE_FORM = /^(\d{1,12})(?:\.(\d{1,6}))? ([A-Z]{3})$/;

/** Parses `"$0.04"` or `"0.04 USD"`. Zero is allowed. */
export function parseMoney(input: string): Money {
  const symbol = SYMBOL_FORM.exec(input);
  if (symbol) return build(SYMBOLS[symbol[1] ?? ''], symbol[2], symbol[3], input);
  const code = CODE_FORM.exec(input);
  if (code) return build(code[3], code[1], code[2], input);
  throw new TollstileError(
    'CONFIG_INVALID',
    `Invalid amount "${input}": use "$0.04" or "0.04 USD", with at most 6 decimal places.`,
  );
}

export function money(currency: string, micros: bigint): Money {
  return { currency, micros };
}

export function zero(currency: string): Money {
  return { currency, micros: 0n };
}

export function formatMoney(amount: Money): string {
  const whole = amount.micros / MICROS;
  const fraction = (amount.micros % MICROS).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  const symbol = Object.entries(SYMBOLS).find(([, currency]) => currency === amount.currency)?.[0];
  const digits = `${whole.toString()}.${fraction}`;
  return symbol === undefined ? `${digits} ${amount.currency}` : `${symbol}${digits}`;
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, micros: a.micros + b.micros };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { currency: a.currency, micros: a.micros - b.micros };
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.micros < b.micros ? -1 : a.micros > b.micros ? 1 : 0;
}

/**
 * Converts to an asset with `scale` decimal places at par, e.g. USD micros to USDC (scale 6) or
 * cents (scale 2). Refuses amounts that the asset cannot represent exactly.
 */
export function toAssetUnits(amount: Money, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new TollstileError('CONFIG_INVALID', `Asset scale must be an integer from 0 to 18, got ${String(scale)}.`);
  }
  if (scale >= 6) return amount.micros * 10n ** BigInt(scale - 6);
  const divisor = 10n ** BigInt(6 - scale);
  if (amount.micros % divisor !== 0n) {
    throw new TollstileError(
      'CONFIG_INVALID',
      `${formatMoney(amount)} cannot be represented with ${String(scale)} decimal places.`,
    );
  }
  return amount.micros / divisor;
}

function build(currency: string | undefined, whole: string | undefined, fraction: string | undefined, input: string): Money {
  if (currency === undefined || whole === undefined) {
    throw new TollstileError('CONFIG_INVALID', `Invalid amount "${input}".`);
  }
  return { currency, micros: BigInt(whole) * MICROS + BigInt((fraction ?? '').padEnd(6, '0')) };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TollstileError(
      'CURRENCY_MISMATCH',
      `Cannot combine ${a.currency} and ${b.currency}. Tollstile never converts currencies.`,
    );
  }
}
