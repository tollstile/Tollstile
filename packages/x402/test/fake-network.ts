import type { Clock } from 'tollstile';

/**
 * A fake x402 facilitator and a fake EVM JSON-RPC node sharing one chain, reachable through an
 * injected `fetch`. The facilitator performs the same economic effect a real one does: it marks
 * the authorization nonce used and emits the token's logs in a mined block.
 */

export const FACILITATOR_URL = 'https://facilitator.test';
export const RPC_URL = 'https://rpc.test';
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const UPTO_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const AUTHORIZATION_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
const AUTHORIZATION_CANCELED = '0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81';
const UNORDERED_NONCE_INVALIDATION = '0x3704902f963766a4e561bbaab6e6cdc1b1dd12f6e9e99648da8843b3f46b918d';
const UPTO_SETTLE = '0xff11e7b4';
const BLOCK_SECONDS = 2n;

type Json = unknown;
type Record_ = Record<string, Json>;

export type FacilitatorMode =
  | 'ok'
  | 'unreachable'
  | 'hang'
  | 'settle-hang'
  | 'unexpected-verify-error'
  | 'verify-bad-signature'
  | 'settle-pending-after-effect'
  | 'settle-html-502'
  | 'settle-rejected'
  | 'settle-rejected-non-2xx';

type Log = { blockNumber: bigint; address: string; topics: string[]; data: string; transactionHash: string };
type Transaction = { to: string; input: string; blockNumber: bigint; logs: Log[] };

export type FakeNetwork = ReturnType<typeof fakeNetwork>;

export function fakeNetwork(clock: Clock) {
  const genesis = BigInt(Math.floor(clock.now().getTime() / 1000)) - 1_000_000n;
  const usedNonces = new Map<string, bigint>();
  const transactions = new Map<string, Transaction>();
  const calls = { verify: [] as Record_[], settle: [] as Record_[], rpc: [] as string[] };
  let mode: FacilitatorMode = 'ok';
  let nextSettle: 'lose-response' | 'fail' | undefined;
  let rpcDown = false;

  const now = () => BigInt(Math.floor(clock.now().getTime() / 1000));
  const latest = () => (now() - genesis) / BLOCK_SECONDS;
  const timestampOf = (block: bigint) => genesis + block * BLOCK_SECONDS;

  const verdict = (body: Record_): { ok: true; payer: string } | { ok: false; reason: string } => {
    const requirements = body.paymentRequirements as Record_;
    const payload = (body.paymentPayload as Record_).payload as Record_;
    if (requirements.scheme === 'exact') {
      const authorization = payload.authorization as Record_;
      if (usedNonces.has(key(authorization.from, authorization.nonce))) return { ok: false, reason: 'invalid_transaction_state' };
      if (BigInt(authorization.validBefore as string) <= now()) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_valid_before' };
      if (authorization.value !== requirements.amount) return { ok: false, reason: 'invalid_exact_evm_payload_authorization_value_mismatch' };
      return { ok: true, payer: authorization.from as string };
    }
    const authorization = payload.permit2Authorization as Record_;
    if (usedNonces.has(key(authorization.from, BigInt(authorization.nonce as string)))) return { ok: false, reason: 'invalid_transaction_state' };
    if (BigInt(authorization.deadline as string) < now()) return { ok: false, reason: 'permit2_deadline_expired' };
    return { ok: true, payer: authorization.from as string };
  };

  const settleOnChain = (body: Record_): string => {
    const requirements = body.paymentRequirements as Record_;
    const payload = (body.paymentPayload as Record_).payload as Record_;
    const hash = `0x${(transactions.size + 1).toString(16).padStart(64, 'a')}`;
    const blockNumber = latest();
    if (requirements.scheme === 'exact') {
      const authorization = payload.authorization as Record_;
      usedNonces.set(key(authorization.from, authorization.nonce), blockNumber);
      const logs = [
        log(blockNumber, USDC, [AUTHORIZATION_USED, word(authorization.from as string), word(authorization.nonce as string)], '0x', hash),
        log(blockNumber, USDC, [TRANSFER, word(authorization.from as string), word(authorization.to as string)], word(BigInt(authorization.value as string)), hash),
      ];
      transactions.set(hash, { to: USDC, input: '0xe3ee160e', blockNumber, logs });
      return hash;
    }
    const authorization = payload.permit2Authorization as Record_;
    const permitted = authorization.permitted as Record_;
    const witness = authorization.witness as Record_;
    const nonce = BigInt(authorization.nonce as string);
    usedNonces.set(key(authorization.from, nonce), blockNumber);
    const input =
      UPTO_SETTLE +
      [
        word(permitted.token as string),
        word(BigInt(permitted.amount as string)),
        word(nonce),
        word(BigInt(authorization.deadline as string)),
        word(BigInt(requirements.amount as string)),
        word(authorization.from as string),
        word(witness.to as string),
        word(witness.facilitator as string),
        word(BigInt(witness.validAfter as string)),
      ]
        .map((value) => value.slice(2))
        .join('');
    const logs = [
      log(blockNumber, USDC, [TRANSFER, word(authorization.from as string), word(witness.to as string)], word(BigInt(requirements.amount as string)), hash),
    ];
    transactions.set(hash, { to: UPTO_PROXY, input, blockNumber, logs });
    return hash;
  };

  const facilitator = (path: string, body: Record_): Response => {
    if (path === '/verify') {
      calls.verify.push(body);
      if (mode === 'unexpected-verify-error') return json(500, { isValid: false, invalidReason: 'unexpected_verify_error' });
      if (mode === 'verify-bad-signature') return json(200, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' });
      const result = verdict(body);
      return result.ok ? json(200, { isValid: true, payer: result.payer }) : json(200, { isValid: false, invalidReason: result.reason });
    }

    calls.settle.push(body);
    const network = (body.paymentRequirements as Record_).network;
    const fault = nextSettle;
    nextSettle = undefined;
    if (mode === 'settle-rejected') return json(200, { success: false, errorReason: 'insufficient_funds', transaction: '', network });
    if (mode === 'settle-rejected-non-2xx') return json(400, { success: false, errorReason: 'insufficient_funds', transaction: '', network });
    if (mode === 'settle-html-502') return new Response('<html>Bad Gateway</html>', { status: 502 });
    const result = verdict(body);
    if (!result.ok) return json(200, { success: false, errorReason: result.reason, transaction: '', network });
    const transaction = settleOnChain(body);
    if (mode === 'settle-pending-after-effect' || fault === 'lose-response') {
      return json(200, { success: false, errorReason: 'settlement_pending', transaction, network });
    }
    return json(200, { success: true, transaction, network, payer: result.payer, amount: (body.paymentRequirements as Record_).amount });
  };

  const rpc = (body: Record_): Response => {
    const method = body.method as string;
    const params = body.params as Json[];
    calls.rpc.push(method);
    if (rpcDown) return json(503, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'down' } });
    const result = (value: Json) => json(200, { jsonrpc: '2.0', id: body.id, result: value });

    switch (method) {
      case 'eth_getBlockByNumber': {
        const number = params[0] === 'finalized' ? latest() : BigInt(params[0] as string);
        return result({ number: hex(number), timestamp: hex(timestampOf(number)) });
      }
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: string };
        const block = BigInt(params[1] as string);
        const words = data.slice(10).match(/.{64}/g) ?? [];
        const owner = `0x${(words[0] ?? '').slice(24)}`;
        if (same(to, USDC) && data.startsWith('0xe94a0102')) {
          const used = usedNonces.get(key(owner, `0x${words[1] ?? ''}`));
          return result(word(used !== undefined && used <= block ? 1n : 0n));
        }
        if (same(to, PERMIT2) && data.startsWith('0x4fe02b44')) {
          const wordPosition = BigInt(`0x${words[1] ?? '0'}`);
          let bitmap = 0n;
          for (const [entry, usedAt] of usedNonces) {
            const [from, nonce] = entry.split(':');
            if (from !== owner.toLowerCase() || nonce === undefined || nonce.startsWith('0x') || usedAt > block) continue;
            if (BigInt(nonce) >> 8n === wordPosition) bitmap |= 1n << (BigInt(nonce) & 0xffn);
          }
          return result(word(bitmap));
        }
        return result('0x');
      }
      case 'eth_getLogs': {
        const filter = params[0] as { address: string; topics: (string | null)[]; fromBlock: string; toBlock: string };
        const logs = [...transactions.values()]
          .flatMap((transaction) => transaction.logs)
          .filter(
            (entry) =>
              same(entry.address, filter.address) &&
              entry.blockNumber >= BigInt(filter.fromBlock) &&
              entry.blockNumber <= BigInt(filter.toBlock) &&
              filter.topics.every((topic, index) => topic === null || topic === entry.topics[index]),
          );
        return result(logs.map(toRpcLog));
      }
      case 'eth_getTransactionReceipt': {
        const transaction = transactions.get(params[0] as string);
        return result(transaction === undefined ? null : { status: '0x1', logs: transaction.logs.map(toRpcLog) });
      }
      case 'eth_getTransactionByHash': {
        const transaction = transactions.get(params[0] as string);
        return result(transaction === undefined ? null : { to: transaction.to, input: transaction.input });
      }
      default:
        return json(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } });
    }
  };

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record_;
    if (url.origin === new URL(FACILITATOR_URL).origin) {
      if (mode === 'unreachable') throw new TypeError('fetch failed');
      if (url.pathname === '/settle' && nextSettle === 'fail') {
        nextSettle = undefined;
        throw new TypeError('fetch failed');
      }
      if (mode === 'hang' || (mode === 'settle-hang' && url.pathname === '/settle')) {
        const signal = init?.signal;
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return facilitator(url.pathname, body);
    }
    return Promise.resolve(rpc(body));
  };

  const mine = (to: string, input: string, logs: Omit<Log, 'blockNumber' | 'transactionHash'>[]) => {
    const hash = `0x${(transactions.size + 1).toString(16).padStart(64, 'c')}`;
    const blockNumber = latest();
    transactions.set(hash, { to, input, blockNumber, logs: logs.map((entry) => ({ ...entry, blockNumber, transactionHash: hash })) });
  };

  return {
    fetch: fetcher,
    /** The payer cancels an EIP-3009 authorization on the token. */
    cancelAuthorization(from: string, nonce: string) {
      usedNonces.set(key(from, nonce), latest());
      mine(USDC, '0x5a049a70', [{ address: USDC, topics: [AUTHORIZATION_CANCELED, word(from), word(nonce)], data: '0x' }]);
    },
    /** The payer invalidates a Permit2 nonce, and separately sends `payTo` a plain transfer of the same amount. */
    invalidatePermit2Nonce(from: string, nonce: bigint, payTo: string, amount: bigint) {
      usedNonces.set(key(from, nonce), latest());
      mine(PERMIT2, '0x3ff9dcb1', [{ address: PERMIT2, topics: [UNORDERED_NONCE_INVALIDATION, word(from)], data: word(nonce >> 8n) + word(1n << (nonce & 0xffn)).slice(2) }]);
      mine(USDC, '0xa9059cbb', [{ address: USDC, topics: [TRANSFER, word(from), word(payTo)], data: word(amount) }]);
    },
    calls,
    simulate(next: FacilitatorMode) {
      mode = next;
    },
    /** One-shot fault for the next `/settle`: perform it but lose the answer, or fail before any effect. */
    faultNextSettle(fault: 'lose-response' | 'fail') {
      nextSettle = fault;
    },
    rpcDown(down: boolean) {
      rpcDown = down;
    },
    /** Transfers the facilitator mined. */
    get settlements() {
      return [...transactions.values()].filter((transaction) => transaction.to === UPTO_PROXY || transaction.input === '0xe3ee160e').length;
    },
  };
}

function key(from: Json, nonce: Json): string {
  return `${String(from).toLowerCase()}:${typeof nonce === 'bigint' ? nonce.toString() : String(nonce).toLowerCase()}`;
}

function log(blockNumber: bigint, address: string, topics: string[], data: string, transactionHash: string): Log {
  return { blockNumber, address, topics, data, transactionHash };
}

function toRpcLog(entry: Log) {
  return { ...entry, blockNumber: hex(entry.blockNumber), removed: false };
}

export function word(value: bigint | string): string {
  const digits = typeof value === 'bigint' ? value.toString(16) : value.slice(2).toLowerCase();
  return `0x${digits.padStart(64, '0')}`;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function json(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
