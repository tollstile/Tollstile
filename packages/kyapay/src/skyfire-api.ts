import { TollstileError, type Json, type Money } from 'tollstile';
import { providerRequest } from './provider-request';
import { formatUsdDecimal, parseUsdDecimal } from './usd-decimal';
import { isJsonObject, stringField } from './wire';

/** One charge on a token, as Skyfire's charge list reports it. */
export type SkyfireCharge = {
  readonly chargeId: string;
  readonly value: Money;
  readonly chargedAt: Date;
};

export type ChargeListing =
  | { readonly status: 'found'; readonly charges: readonly SkyfireCharge[] }
  /** Skyfire answered 404. Whether that means "no charges yet" or "unknown token" is not documented. */
  | { readonly status: 'not_found' };

export type ChargeOutcome =
  | { readonly status: 'charged'; readonly amountCharged: string; readonly remainingBalance: string }
  | { readonly status: 'rejected'; readonly code: string };

export type SkyfireApi = {
  charge(token: string, amount: Money, signal: AbortSignal): Promise<ChargeOutcome>;
  listCharges(tokenId: string, signal: AbortSignal): Promise<ChargeListing>;
};

/**
 * Error codes Skyfire documents as stable. Each is returned for a request it did not carry out, so a
 * charge answered with one of them moved no money. Any other failure leaves the outcome unknown.
 */
const REJECTION_CODES = new Set([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'NOT_AUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_ELIGIBLE',
  'PAYMENT_DECLINED',
  'PAYMENT_ERROR',
]);
const PAGE_SIZE = 100;
/** A token with more charges than this cannot be reasoned about within one provider call. */
const MAX_PAGES = 50;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The seller-side Skyfire token API. The API key travels only in the request header, never in errors. */
export function skyfireApi(options: { readonly url: string; readonly apiKey: string; readonly fetch: typeof fetch }): SkyfireApi {
  const headers = { 'skyfire-api-key': options.apiKey, accept: 'application/json' };

  return {
    async charge(token, amount, signal) {
      const response = await providerRequest(
        options.fetch,
        `${options.url}/api/v1/tokens/charge`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ token, chargeAmount: formatUsdDecimal(amount) }),
        },
        signal,
        'charge',
      );

      if (response.status === 200 && isJsonObject(response.body)) {
        const amountCharged = stringField(response.body, 'amountCharged');
        const remainingBalance = stringField(response.body, 'remainingBalance');
        const charged = amountCharged === undefined ? undefined : parseUsdDecimal(amountCharged);
        if (charged?.micros === amount.micros && remainingBalance !== undefined && parseUsdDecimal(remainingBalance) !== undefined) {
          return { status: 'charged', amountCharged: formatUsdDecimal(charged), remainingBalance };
        }
        // Money may have moved, but not the amount the ledger would record.
        throw new TollstileError('PROVIDER_TIMEOUT', `Skyfire answered a charge of ${formatUsdDecimal(amount)} with an unexpected body; its outcome is unknown.`);
      }

      const code = errorCode(response.body);
      if (response.status >= 400 && response.status < 500 && code !== undefined && REJECTION_CODES.has(code)) {
        return { status: 'rejected', code };
      }
      throw new TollstileError('PROVIDER_TIMEOUT', `Skyfire answered a charge with HTTP ${response.status}${code === undefined ? '' : ` ${code}`}; its outcome is unknown.`);
    },

    async listCharges(tokenId, signal) {
      const charges: SkyfireCharge[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ size: String(PAGE_SIZE) });
        if (cursor !== undefined) query.set('pageCursor', cursor);
        const response = await providerRequest(
          options.fetch,
          `${options.url}/api/v1/tokens/${encodeURIComponent(tokenId)}/charges?${query.toString()}`,
          { method: 'GET', headers },
          signal,
          'charge lookup',
        );

        if (response.status === 404 && page === 0 && errorCode(response.body) === 'NOT_FOUND') return { status: 'not_found' };
        if (response.status === 401 || response.status === 403) {
          throw new TollstileError('PROVIDER_UNAVAILABLE', `Skyfire rejected the seller API key while listing charges (HTTP ${response.status}). Check apiKey.`);
        }
        const body = response.body;
        const data = isJsonObject(body) ? body.data : undefined;
        if (response.status !== 200 || !isJsonObject(body) || !Array.isArray(data)) {
          throw new TollstileError('PROVIDER_UNAVAILABLE', `Skyfire returned an unusable charge list (HTTP ${response.status}).`);
        }
        // JSON.parse produced `data`, so its members are JSON values.
        for (const item of data as readonly Json[]) charges.push(parseCharge(item, tokenId));

        const next = stringField(body, 'nextPageCursor');
        if (next === undefined || next === '') return { status: 'found', charges };
        if (seen.has(next)) throw new TollstileError('PROVIDER_UNAVAILABLE', 'Skyfire repeated a charge list page cursor.');
        seen.add(next);
        cursor = next;
      }
      throw new TollstileError('PROVIDER_TIMEOUT', `Token ${tokenId} has more than ${PAGE_SIZE * MAX_PAGES} charges; they cannot be listed in one lookup.`);
    },
  };
}

function parseCharge(item: Json, tokenId: string): SkyfireCharge {
  // A record that cannot be read exactly makes any conclusion about the token's charges unsound.
  const unreadable = new TollstileError('PROVIDER_UNAVAILABLE', `Skyfire returned a charge record for token ${tokenId} that cannot be read.`);
  if (!isJsonObject(item) || stringField(item, 'tokenId') !== tokenId) throw unreadable;
  const chargeId = stringField(item, 'chargeId');
  const value = parseUsdDecimal(stringField(item, 'value') ?? '');
  const chargedAt = stringField(item, 'chargedAt') ?? '';
  const time = new Date(chargedAt);
  if (chargeId === undefined || value === undefined || !ISO_TIMESTAMP.test(chargedAt) || Number.isNaN(time.getTime())) throw unreadable;
  return { chargeId, value, chargedAt: time };
}

function errorCode(body: Json | undefined): string | undefined {
  return isJsonObject(body) ? stringField(body, 'code') : undefined;
}
