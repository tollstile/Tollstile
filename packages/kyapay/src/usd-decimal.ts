import { money, type Money } from 'tollstile';

const MICROS_PER_DOLLAR = 1_000_000n;
const DECIMAL = /^(\d{1,12})(?:\.(\d+))?$/;

/**
 * A KYAPay decimal string in US dollars ("0.01", "15") as Money. Precision finer than a micro-dollar
 * is refused rather than rounded, so an amount on the wire is never silently changed.
 */
export function parseUsdDecimal(input: string): Money | undefined {
  const match = DECIMAL.exec(input);
  if (match === null) return undefined;
  const fraction = match[2] ?? '';
  if (/[1-9]/.test(fraction.slice(6))) return undefined;
  return money('USD', BigInt(match[1] ?? '0') * MICROS_PER_DOLLAR + BigInt(fraction.slice(0, 6).padEnd(6, '0')));
}

/** The decimal string Skyfire expects for `chargeAmount`, e.g. 10000 micros → "0.01". */
export function formatUsdDecimal(amount: Money): string {
  const whole = (amount.micros / MICROS_PER_DOLLAR).toString();
  const fraction = (amount.micros % MICROS_PER_DOLLAR).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
