import { concat, fromHex, isObject, toBigInt, toHex, utf8 } from './encoding';
import { addressWord, keccak256, parseAddress, parseBytes32, selector, word, ZERO_ADDRESS, type Address } from './evm';

/** The TIP-20 channel escrow precompile (TIP-1034), session protocol `v2`. */
export const TEMPO_CHANNEL_ESCROW: Address = '0x4d50500000000000000000000000000000000000';

/** The immutable identity of a v2 channel. Every field is bound into the channel id. */
export type ChannelDescriptor = {
  readonly payer: Address;
  readonly payee: Address;
  readonly operator: Address;
  readonly token: Address;
  readonly salt: `0x${string}`;
  readonly authorizedSigner: Address;
  readonly expiringNonceHash: `0x${string}`;
};

export type ChannelState = {
  readonly settled: bigint;
  readonly deposit: bigint;
  readonly closeRequestedAt: bigint;
};

export const MAX_UINT96 = (1n << 96n) - 1n;

const DOMAIN_TYPE = keccak256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const DOMAIN_NAME = keccak256(utf8('TIP20 Channel Reserve'));
const DOMAIN_VERSION = keccak256(utf8('1'));
const VOUCHER_TYPE = keccak256(utf8('Voucher(bytes32 channelId,uint96 cumulativeAmount)'));
const GET_CHANNEL_STATE = selector('getChannelState(bytes32)');
const CLOSE = selector('close((address,address,address,address,bytes32,address,bytes32),uint96,uint96,bytes)');

export function parseDescriptor(value: unknown): ChannelDescriptor | undefined {
  if (!isObject(value)) return undefined;
  const payer = parseAddress(value.payer);
  const payee = parseAddress(value.payee);
  const operator = parseAddress(value.operator);
  const token = parseAddress(value.token);
  const salt = parseBytes32(value.salt);
  const authorizedSigner = parseAddress(value.authorizedSigner);
  const expiringNonceHash = parseBytes32(value.expiringNonceHash);
  if (
    payer === undefined ||
    payee === undefined ||
    operator === undefined ||
    token === undefined ||
    salt === undefined ||
    authorizedSigner === undefined ||
    expiringNonceHash === undefined
  ) {
    return undefined;
  }
  return { payer, payee, operator, token, salt, authorizedSigner, expiringNonceHash };
}

/** `keccak256(abi.encode(payer, payee, operator, token, salt, authorizedSigner, expiringNonceHash, escrow, chainId))`. */
export function channelId(descriptor: ChannelDescriptor, escrow: Address, chainId: number): `0x${string}` {
  return toHex(keccak256(concat(descriptorWords(descriptor), addressWord(escrow), word(BigInt(chainId)))));
}

/** The signer vouchers must recover to: the delegated signer, or the payer when none is set. */
export function voucherSigner(descriptor: ChannelDescriptor): Address {
  return descriptor.authorizedSigner === ZERO_ADDRESS ? descriptor.payer : descriptor.authorizedSigner;
}

/** EIP-712 digest of `Voucher(bytes32 channelId, uint96 cumulativeAmount)` under the escrow's domain. */
export function voucherDigest(escrow: Address, chainId: number, channel: `0x${string}`, cumulativeAmount: bigint): Uint8Array {
  const domain = keccak256(concat(DOMAIN_TYPE, DOMAIN_NAME, DOMAIN_VERSION, word(BigInt(chainId)), addressWord(escrow)));
  const voucher = keccak256(concat(VOUCHER_TYPE, fromHex(channel) ?? new Uint8Array(32), word(cumulativeAmount)));
  return keccak256(concat(Uint8Array.of(0x19, 0x01), domain, voucher));
}

export function getChannelStateCall(channel: `0x${string}`): `0x${string}` {
  return toHex(concat(fromHex(GET_CHANNEL_STATE) ?? new Uint8Array(), fromHex(channel) ?? new Uint8Array(32)));
}

/** Decodes the `(uint96 settled, uint96 deposit, uint32 closeRequestedAt)` return tuple. */
export function decodeChannelState(result: unknown): ChannelState | undefined {
  const bytes = typeof result === 'string' ? fromHex(result) : undefined;
  if (bytes?.length !== 96) return undefined;
  return {
    settled: toBigInt(bytes.subarray(0, 32)),
    deposit: toBigInt(bytes.subarray(32, 64)),
    closeRequestedAt: toBigInt(bytes.subarray(64, 96)),
  };
}

/** Calldata for `close(descriptor, cumulativeAmount, captureAmount, signature)`. */
export function closeCall(descriptor: ChannelDescriptor, cumulativeAmount: bigint, captureAmount: bigint, signature: Uint8Array): `0x${string}` {
  const padded = new Uint8Array(Math.ceil(signature.length / 32) * 32);
  padded.set(signature);
  const head = concat(descriptorWords(descriptor), word(cumulativeAmount), word(captureAmount), word(10n * 32n));
  return toHex(concat(fromHex(CLOSE) ?? new Uint8Array(), head, word(BigInt(signature.length)), padded));
}

function descriptorWords(descriptor: ChannelDescriptor): Uint8Array {
  return concat(
    addressWord(descriptor.payer),
    addressWord(descriptor.payee),
    addressWord(descriptor.operator),
    addressWord(descriptor.token),
    fromHex(descriptor.salt) ?? new Uint8Array(32),
    addressWord(descriptor.authorizedSigner),
    fromHex(descriptor.expiringNonceHash) ?? new Uint8Array(32),
  );
}
