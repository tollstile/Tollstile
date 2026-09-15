import { TollstileError, type Json, type JsonObject } from 'tollstile';
import { postJson, type Fetch } from './provider-fetch';
import { isObject, textField } from './wire';

export type Block = { readonly number: bigint; readonly timestamp: bigint };

export type Log = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
};

export type LogFilter = {
  readonly address: string;
  /** `null` matches any value in that position. */
  readonly topics: readonly (string | null)[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
};

/** The read-only chain queries reconciliation uses. */
export type Chain = {
  block(tag: 'finalized' | bigint, signal: AbortSignal): Promise<Block>;
  call(to: string, data: string, block: bigint, signal: AbortSignal): Promise<string>;
  logs(filter: LogFilter, signal: AbortSignal): Promise<readonly Log[]>;
  receiptLogs(transactionHash: string, signal: AbortSignal): Promise<readonly Log[]>;
  transaction(transactionHash: string, signal: AbortSignal): Promise<{ readonly to: string | null; readonly input: string }>;
};

const LABEL = 'x402 JSON-RPC node';
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;
const DATA = /^0x[0-9a-fA-F]*$/;

export function jsonRpcChain(url: string, fetcher: Fetch): Chain {
  let id = 0;
  const request = async (method: string, params: readonly Json[], signal: AbortSignal): Promise<Json> => {
    id += 1;
    const { status, body } = await postJson(fetcher, {
      url,
      body: { jsonrpc: '2.0', id, method, params },
      headers: {},
      signal,
      label: `${LABEL} ${method}`,
    });
    if (!isObject(body) || !('result' in body)) {
      const code = isObject(body) && isObject(body.error) && typeof body.error.code === 'number' ? ` (error ${String(body.error.code)})` : '';
      throw unavailable(`${method} answered HTTP ${String(status)} without a result${code}.`);
    }
    return body.result ?? null;
  };

  return {
    async block(tag, signal) {
      const result = await request('eth_getBlockByNumber', [typeof tag === 'bigint' ? quantity(tag) : tag, false], signal);
      const number = isObject(result) ? hexQuantity(result, 'number') : undefined;
      const timestamp = isObject(result) ? hexQuantity(result, 'timestamp') : undefined;
      if (number === undefined || timestamp === undefined) throw unavailable(`eth_getBlockByNumber returned no block for ${String(tag)}.`);
      return { number, timestamp };
    },

    async call(to, data, block, signal) {
      const result = await request('eth_call', [{ to, data }, quantity(block)], signal);
      if (typeof result !== 'string' || !DATA.test(result)) throw unavailable('eth_call returned malformed data.');
      return result;
    },

    async logs(filter, signal) {
      const result = await request(
        'eth_getLogs',
        [
          {
            address: filter.address,
            topics: [...filter.topics],
            fromBlock: quantity(filter.fromBlock),
            toBlock: quantity(filter.toBlock),
          },
        ],
        signal,
      );
      if (!Array.isArray(result)) throw unavailable('eth_getLogs returned malformed logs.');
      return parseLogs(result);
    },

    async receiptLogs(transactionHash, signal) {
      const result = await request('eth_getTransactionReceipt', [transactionHash], signal);
      if (!isObject(result) || !Array.isArray(result.logs)) throw unavailable(`eth_getTransactionReceipt returned no receipt for ${transactionHash}.`);
      // A reverted transaction keeps no logs, but its receipt says so explicitly.
      if (result.status !== '0x1') return [];
      return parseLogs(result.logs);
    },

    async transaction(transactionHash, signal) {
      const result = await request('eth_getTransactionByHash', [transactionHash], signal);
      const input = isObject(result) ? textField(result, 'input') : undefined;
      if (!isObject(result) || input === undefined || !DATA.test(input)) {
        throw unavailable(`eth_getTransactionByHash returned no transaction for ${transactionHash}.`);
      }
      return { to: textField(result, 'to') ?? null, input };
    },
  };
}

function parseLogs(values: readonly Json[]): readonly Log[] {
  return values.map((value) => {
    const log = isObject(value) ? parseLog(value) : undefined;
    if (log === undefined) throw unavailable('a JSON-RPC log entry is malformed.');
    return log;
  }).filter((log): log is Log => log !== 'removed');
}

function parseLog(value: JsonObject): Log | 'removed' | undefined {
  // Logs from blocks that were reorganized away describe nothing that happened.
  if (value.removed === true) return 'removed';
  const address = textField(value, 'address');
  const data = textField(value, 'data');
  const transactionHash = textField(value, 'transactionHash');
  const topics = Array.isArray(value.topics) ? value.topics : [];
  if (address === undefined || data === undefined || !DATA.test(data) || transactionHash === undefined) return undefined;
  if (!topics.every((topic): topic is string => typeof topic === 'string')) return undefined;
  return { address, data, transactionHash, topics: topics.map((topic) => topic.toLowerCase()) };
}

function hexQuantity(record: JsonObject, key: string): bigint | undefined {
  const value = textField(record, key);
  return value !== undefined && QUANTITY.test(value) ? BigInt(value) : undefined;
}

function quantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function unavailable(message: string): TollstileError {
  return new TollstileError('PROVIDER_UNAVAILABLE', `${LABEL}: ${message}`);
}
