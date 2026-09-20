import { encodeCall, readWord, word } from '../../src/abi';

/**
 * The reads this harness needs beyond what reconciliation uses: chain id, balances, the Permit2
 * allowance, and one transaction receipt. Deliberately its own small client rather than the rail's
 * `Chain`, so a verification run cannot pass because the code under test reads the chain its way.
 */

/** `balanceOf(address)` */
const BALANCE_OF = '0x70a08231';
/** `allowance(address,address)` */
const ALLOWANCE = '0xdd62ed3e';
/** `decimals()` */
const DECIMALS = '0x313ce567';
/** `Transfer(address,address,uint256)` */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type Transfer = { readonly from: string; readonly to: string; readonly amount: bigint };

export type Receipt = {
  readonly status: 'success' | 'reverted';
  readonly blockNumber: bigint;
  readonly transfers: readonly Transfer[];
};

export class Rpc {
  #id = 0;

  constructor(private readonly url: string) {}

  async chainId(): Promise<bigint> {
    return quantity(await this.send('eth_chainId', []));
  }

  async nativeBalance(address: string): Promise<bigint> {
    return quantity(await this.send('eth_getBalance', [address, 'latest']));
  }

  async tokenBalance(token: string, owner: string): Promise<bigint> {
    return this.readUint(token, encodeCall(BALANCE_OF, word(owner)));
  }

  async allowance(token: string, owner: string, spender: string): Promise<bigint> {
    return this.readUint(token, encodeCall(ALLOWANCE, word(owner), word(spender)));
  }

  async decimals(token: string): Promise<number> {
    return Number(await this.readUint(token, DECIMALS));
  }

  /** `undefined` while the transaction is unknown to the node or still pending. */
  async receipt(transactionHash: string, token: string): Promise<Receipt | undefined> {
    const result = await this.send('eth_getTransactionReceipt', [transactionHash]);
    if (result === null) return undefined;
    const receipt = object(result);
    const logs = Array.isArray(receipt['logs']) ? receipt['logs'] : [];
    const transfers: Transfer[] = [];
    for (const entry of logs) {
      const log = object(entry);
      const topics = Array.isArray(log['topics']) ? log['topics'].map((topic) => text(topic)) : [];
      if (!sameAddress(text(log['address']), token)) continue;
      if (topics[0] !== TRANSFER_TOPIC || topics[1] === undefined || topics[2] === undefined) continue;
      transfers.push({ from: addressOf(topics[1]), to: addressOf(topics[2]), amount: quantity(log['data']) });
    }
    return { status: text(receipt['status']) === '0x1' ? 'success' : 'reverted', blockNumber: quantity(receipt['blockNumber']), transfers };
  }

  private async readUint(to: string, data: string): Promise<bigint> {
    const value = readWord(text(await this.send('eth_call', [{ to, data }, 'latest'])), 0);
    if (value === undefined) throw new Error(`${to} returned data this harness cannot read.`);
    return value;
  }

  private async send(method: string, params: readonly unknown[]): Promise<unknown> {
    this.#id += 1;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#id, method, params }),
    });
    if (!response.ok) throw new Error(`${method} on the JSON-RPC endpoint answered ${String(response.status)}.`);
    const body = object(await response.json());
    if ('error' in body) throw new Error(`${method} failed: ${JSON.stringify(body['error'])}`);
    return body['result'] ?? null;
  }
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function addressOf(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

function quantity(value: unknown): bigint {
  const hex = text(value);
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) throw new Error('The node returned a quantity this harness cannot read.');
  return hex === '0x' ? 0n : BigInt(hex);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('The node returned a value where a string was expected.');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The node returned a value where an object was expected.');
  return value as Record<string, unknown>;
}
