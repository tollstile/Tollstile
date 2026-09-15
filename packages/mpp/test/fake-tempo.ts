import { secp256k1 } from '@noble/curves/secp256k1.js';
import { concat, fromHex, toHex, utf8 } from '../src/encoding';
import { addressWord, keccak256, publicKeyAddress, selector, word, type Address } from '../src/evm';
import { encodeRlp, integerBytes, type RlpItem } from '../src/rlp';
import { decodeTempoTransaction } from '../src/tempo-transaction';

export const CHAIN_ID = 42431;
export const TOKEN: Address = '0x20c0000000000000000000000000000000000000';
export const RECIPIENT: Address = '0x742d35cc6634c0532925a3b844bc9e7595f8fe00';

export type Wallet = { readonly secretKey: Uint8Array; readonly address: Address };

export function wallet(): Wallet {
  const { secretKey } = secp256k1.keygen();
  return { secretKey, address: publicKeyAddress(secp256k1.getPublicKey(secretKey, false)) };
}

/** `r‖s‖v` with v ∈ {27, 28}, as Ethereum tooling produces. */
export function sign(digest: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(digest, secretKey, { prehash: false, format: 'recovered' });
  return concat(recovered.subarray(1), Uint8Array.of(27 + (recovered[0] ?? 0)));
}

export type Call = { readonly to: Address; readonly data: Uint8Array };

export function transfer(to: Address, amount: bigint, memo?: string, token: Address = TOKEN): Call {
  const data = memo === undefined
    ? concat(fromHex(selector('transfer(address,uint256)')) ?? new Uint8Array(), addressWord(to), word(amount))
    : concat(fromHex(selector('transferWithMemo(address,uint256,bytes32)')) ?? new Uint8Array(), addressWord(to), word(amount), fromHex(memo) ?? new Uint8Array());
  return { to: token, data };
}

export type TxInput = {
  readonly calls: readonly Call[];
  readonly validBefore: number;
  readonly validAfter?: number;
  readonly chainId?: number;
  readonly nonce?: bigint;
  readonly feePayerMarker?: boolean;
};

/** A signed Tempo Transaction (0x76), client-paid fees in pathUSD. */
export function signTransaction(from: Wallet, input: TxInput): `0x${string}` {
  const int = (value: bigint | number) => integerBytes(BigInt(value));
  const fields: RlpItem[] = [
    int(input.chainId ?? CHAIN_ID),
    int(1_000_000n),
    int(20_000_000_000n),
    int(300_000n),
    input.calls.map((call) => [fromHex(call.to) ?? new Uint8Array(), new Uint8Array(), call.data]),
    [],
    int(0n),
    int(input.nonce ?? 1n),
    int(input.validBefore),
    int(input.validAfter ?? 0),
    fromHex(TOKEN) ?? new Uint8Array(),
    input.feePayerMarker === true ? Uint8Array.of(0) : new Uint8Array(),
    [],
  ];
  const digest = keccak256(concat(Uint8Array.of(0x76), encodeRlp(fields)));
  return toHex(concat(Uint8Array.of(0x76), encodeRlp([...fields, sign(digest, from.secretKey)])));
}

export type TempoMode = 'ok' | 'down' | 'timeout-after-effect' | 'refuse' | 'revert';

type Receipt = { transactionHash: string; status: string; from: string; blockNumber: string; logs: object[] };

const TRANSFER_EVENT = toHex(keccak256(utf8('Transfer(address,address,uint256)')));
const MEMO_EVENT = toHex(keccak256(utf8('TransferWithMemo(address,address,uint256,bytes32)')));

/** A Tempo JSON-RPC node with a mempool of one block, reached through an injected fetch. */
export function fakeTempo() {
  const receipts = new Map<string, Receipt>();
  const channels = new Map<string, { settled: bigint; deposit: bigint; closeRequestedAt: bigint }>();
  const broadcasts: string[] = [];
  const modes: { send: TempoMode; read: 'ok' | 'down' } = { send: 'ok', read: 'ok' };
  /** A fault for the next broadcast only. */
  let nextSend: TempoMode | undefined;

  /** Includes a signed transaction: what the network does when anyone broadcasts it. */
  function include(raw: string, success = true): string {
    const decoded = decodeTempoTransaction(raw);
    if (!decoded.ok) throw new Error(decoded.reason);
    const { transaction } = decoded;
    const existing = receipts.get(transaction.hash);
    if (existing !== undefined) return transaction.hash;
    const logs = success
      ? transaction.calls.flatMap((call) => {
          const selectorHex = toHex(call.data.subarray(0, 4));
          const to = toHex(call.data.subarray(16, 36));
          const amount = toHex(call.data.subarray(36, 68));
          const topic = (address: string) => toHex(concat(new Uint8Array(12), fromHex(address) ?? new Uint8Array()));
          const plain = { address: call.to, topics: [TRANSFER_EVENT, topic(transaction.sender), topic(to)], data: amount };
          if (selectorHex === selector('transfer(address,uint256)')) return [plain];
          return [plain, { address: call.to, topics: [MEMO_EVENT, topic(transaction.sender), topic(to), toHex(call.data.subarray(68, 100))], data: amount }];
        })
      : [];
    receipts.set(transaction.hash, { transactionHash: transaction.hash, status: success ? '0x1' : '0x0', from: transaction.sender, blockNumber: '0x10', logs });
    return transaction.hash;
  }

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id: number; method: string; params: unknown[] };
    const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    const error = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code, message } }), { status: 200 });

    switch (body.method) {
      case 'eth_sendRawTransactionSync': {
        const raw = String(body.params[0]);
        broadcasts.push(raw);
        const send = nextSend ?? modes.send;
        nextSend = undefined;
        if (send === 'down') throw new TypeError('fetch failed');
        if (send === 'refuse') return error(-32000, 'nonce too low');
        const hash = include(raw, send !== 'revert');
        if (send === 'timeout-after-effect') throw new DOMException('The operation timed out.', 'TimeoutError');
        return answer(receipts.get(hash));
      }
      case 'eth_getTransactionReceipt':
        if (modes.read === 'down') throw new TypeError('fetch failed');
        return answer(receipts.get(String(body.params[0]).toLowerCase()) ?? null);
      case 'eth_call': {
        if (modes.read === 'down') throw new TypeError('fetch failed');
        const call = body.params[0] as { to: string; data: string };
        const data = fromHex(call.data) ?? new Uint8Array();
        const channelId = toHex(data.subarray(4, 36));
        const state = channels.get(channelId) ?? { settled: 0n, deposit: 0n, closeRequestedAt: 0n };
        return answer(toHex(concat(word(state.settled), word(state.deposit), word(state.closeRequestedAt))));
      }
      default:
        return error(-32601, 'method not found');
    }
  };

  return {
    fetch,
    receipts,
    broadcasts,
    channels,
    include,
    failNextSend(mode: TempoMode) {
      nextSend = mode;
    },
    /** Successful transfers the network included. */
    transfers: () => [...receipts.values()].filter((receipt) => receipt.status === '0x1').length,
    simulate(next: Partial<typeof modes>) {
      Object.assign(modes, { send: 'ok', read: 'ok' }, next);
    },
  };
}
