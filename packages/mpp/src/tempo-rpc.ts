import { TollstileError, type Json } from 'tollstile';
import { isObject } from './encoding';
import { parseAddress, parseBytes32, type Address } from './evm';

export type RpcConfig = {
  readonly url: string;
  readonly fetch: typeof fetch;
};

export type RpcAnswer = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly code: number; readonly message: string };

export type RpcLog = {
  readonly address: Address;
  readonly topics: readonly `0x${string}`[];
  readonly data: `0x${string}`;
};

export type TransactionReceipt = {
  readonly transactionHash: `0x${string}`;
  readonly success: boolean;
  readonly from: Address;
  readonly blockNumber: string;
  readonly logs: readonly RpcLog[];
};

/**
 * One JSON-RPC call. Transport failures on a call that can move money (`write`) throw
 * `PROVIDER_TIMEOUT`, because the node may have accepted it; on a read they throw
 * `PROVIDER_UNAVAILABLE`. JSON-RPC errors are returned for the caller to classify.
 */
export async function rpcCall(
  config: RpcConfig,
  method: string,
  params: readonly Json[],
  options: { readonly signal: AbortSignal; readonly write: boolean },
): Promise<RpcAnswer> {
  const code = options.write ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
  let response: Response;
  // catch-reason: a failed fetch is the boundary where an unreachable provider becomes PROVIDER_*.
  try {
    response = await config.fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: options.signal,
    });
  } catch (error) {
    throw new TollstileError(code, `Tempo RPC ${method} did not complete.`, { cause: error });
  }
  if (!response.ok) throw new TollstileError(code, `Tempo RPC answered HTTP ${String(response.status)} to ${method}.`);

  let body: unknown;
  // catch-reason: an unparsable RPC body is classified as an unreachable provider, not a crash.
  try {
    body = await response.json();
  } catch (error) {
    throw new TollstileError(code, `Tempo RPC returned an unreadable body for ${method}.`, { cause: error });
  }
  if (!isObject(body)) throw new TollstileError(code, `Tempo RPC returned an unexpected body for ${method}.`);
  if (isObject(body.error)) {
    return {
      ok: false,
      code: typeof body.error.code === 'number' ? body.error.code : 0,
      message: typeof body.error.message === 'string' ? body.error.message : '',
    };
  }
  if (!('result' in body)) throw new TollstileError(code, `Tempo RPC returned neither result nor error for ${method}.`);
  return { ok: true, result: body.result };
}

/** `eth_getTransactionReceipt`: `null` while the transaction is not included. */
export async function getReceipt(config: RpcConfig, hash: string, signal: AbortSignal): Promise<TransactionReceipt | null> {
  const answer = await rpcCall(config, 'eth_getTransactionReceipt', [hash], { signal, write: false });
  if (!answer.ok) throw new TollstileError('PROVIDER_UNAVAILABLE', `Tempo RPC refused eth_getTransactionReceipt (${String(answer.code)}).`);
  if (answer.result === null) return null;
  const receipt = parseReceipt(answer.result);
  if (receipt === undefined) throw new TollstileError('PROVIDER_UNAVAILABLE', 'Tempo RPC returned a malformed transaction receipt.');
  return receipt;
}

export function parseReceipt(value: unknown): TransactionReceipt | undefined {
  if (!isObject(value)) return undefined;
  const hash = parseBytes32(value.transactionHash);
  const from = parseAddress(value.from);
  const { status, blockNumber, logs } = value;
  if (hash === undefined || from === undefined || typeof status !== 'string' || typeof blockNumber !== 'string' || !Array.isArray(logs)) {
    return undefined;
  }
  const parsed: RpcLog[] = [];
  for (const log of logs) {
    if (!isObject(log)) return undefined;
    const address = parseAddress(log.address);
    const topics = Array.isArray(log.topics) ? log.topics.map(parseBytes32) : [];
    if (address === undefined || typeof log.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(log.data)) return undefined;
    if (topics.some((topic) => topic === undefined)) return undefined;
    parsed.push({ address, topics: topics.filter((topic) => topic !== undefined), data: log.data.toLowerCase() as `0x${string}` });
  }
  return { transactionHash: hash, success: status === '0x1', from, blockNumber, logs: parsed };
}
