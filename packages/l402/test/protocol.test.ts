import { describe, expect, it } from 'vitest';
import { parseCredential } from '../src/credential';
import { fromBase64, toHex } from '../src/encoding';
import { describeInvoice } from '../src/invoice';
import { decodeMacaroon, encodeMacaroon, mintMacaroon, verifyMacaroon } from '../src/macaroon';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('macaroon V2 (libmacaroons and go-macaroon vectors)', () => {
  it('reproduces the libmacaroons README signatures, including the key-generator step', async () => {
    const key = utf8('this is our super secret key; only we should know it');
    const id = utf8('we used our secret key');
    const signature = async (caveats: string[]) => toHex((await mintMacaroon(key, id, caveats)).signature);

    expect(await signature([])).toBe('e3d9e02908526c4c0039ae15114115d97fdd68bf2ba379b342aaf0f617d0552f');
    expect(await signature(['account = 3735928559'])).toBe('1efe4763f290dbce0c1d08477367e11f4eee456a64933cf662d79772dbb82128');
    expect(await signature(['account = 3735928559', 'time < 2020-01-01T00:00'])).toBe(
      'b5f06c8c8ef92f6c82c6ff282cd1f8bd1849301d09a2db634ba182536a611c49',
    );
    expect(await signature(['account = 3735928559', 'time < 2020-01-01T00:00', 'email = alice@example.org'])).toBe(
      'ddf553e46083e55b8d71ab822be3d8fcf21d6bf19c40d617bb9fb438934474b6',
    );
  });

  const vectors = {
    root_v2_1: 'AgETaHR0cDovL2V4YW1wbGUub3JnLwIFa2V5aWQAAAYgfN7nklEcW8b1KEhYBd_psk54XijiqZMB-dcRxgnjjvc',
    caveat_v2_1:
      'AgETaHR0cDovL2V4YW1wbGUub3JnLwIFa2V5aWQAAhRhY2NvdW50ID0gMzczNTkyODU1OQAABiD1SAf23G7fiL8PcwazgiVio2JTPb9zObphdl2kvSWdhw',
    caveat_v2_4:
      'AgETaHR0cDovL2V4YW1wbGUub3JnLwIFa2V5aWQAAhRhY2NvdW50ID0gMzczNTkyODU1OQACDHVzZXIgPSBhbGljZQAABiBL6WfNHqDGsmuvakqU7psFsViG2guoXoxCqTyNDhJe_A',
  };

  it.each(Object.entries(vectors))('decodes, re-encodes byte for byte, and verifies %s with the right key only', async (_name, encoded) => {
    const bytes = fromBase64(encoded);
    const macaroon = bytes === undefined ? undefined : decodeMacaroon(bytes);
    if (bytes === undefined || macaroon === undefined) throw new Error('vector did not decode');

    expect(new TextDecoder().decode(macaroon.location)).toBe('http://example.org/');
    expect(new TextDecoder().decode(macaroon.identifier)).toBe('keyid');
    expect(encodeMacaroon(macaroon)).toEqual(bytes);
    expect(await verifyMacaroon(utf8('this is the key'), macaroon)).toBe(true);
    expect(await verifyMacaroon(utf8('this is not the key'), macaroon)).toBe(false);
  });

  it('round-trips go-macaroon TestMarshalBinaryRoundTrip and refuses to verify its third-party caveat', async () => {
    const vid = [...new Array<number>(24).fill(0), ...Buffer.from('d36ec502e05886d1f0279f055fa52554d16d16c1b14074bbb83ff0fdd79dc2fe098f0ed4a2b091130e6b5db46a20a86b', 'hex')];
    const data = Uint8Array.from([
      2,
      ...[1, 14, ...utf8('http://mybank/')],
      ...[2, 28, ...utf8('we used our other secret key')],
      0,
      ...[2, 20, ...utf8('account = 3735928559')],
      0,
      ...[1, 19, ...utf8('http://auth.mybank/')],
      ...[2, 39, ...utf8('this was how we remind auth of key/pred')],
      ...[4, 72, ...vid],
      0,
      0,
      ...[6, 32, ...Buffer.from('d27db2fd1f22760e4c3dae8137e2d8fc1df6c0741c18aed4b97256bf78d1f55c', 'hex')],
    ]);
    const macaroon = decodeMacaroon(data);
    if (macaroon === undefined) throw new Error('vector did not decode');

    expect(macaroon.caveats).toHaveLength(2);
    expect(encodeMacaroon(macaroon)).toEqual(data);
    expect(await verifyMacaroon(utf8('whatever'), macaroon)).toBe(false);
  });

  it('refuses V1, truncated, trailing, and out-of-order encodings', () => {
    const bytes = fromBase64(vectors.root_v2_1);
    if (bytes === undefined) throw new Error('vector did not decode');

    expect(decodeMacaroon(Uint8Array.from([1, ...bytes.slice(1)]))).toBeUndefined();
    expect(decodeMacaroon(bytes.slice(0, -1))).toBeUndefined();
    expect(decodeMacaroon(Uint8Array.from([...bytes, 0]))).toBeUndefined();
    expect(decodeMacaroon(Uint8Array.from([2, 2, 1, 97, 1, 1, 98, 0, 0, 6, 32, ...new Array<number>(32).fill(0)]))).toBeUndefined();
  });
});

describe('credential header', () => {
  const macaroon = 'AgEEbHNhdAJCAAA=';
  const preimage = 'ab'.repeat(32);

  it('reads L402 and the legacy LSAT scheme, case-insensitively', () => {
    for (const value of [`L402 ${macaroon}:${preimage}`, `LSAT ${macaroon}:${preimage}`, `l402 ${macaroon}:${preimage.toUpperCase()}`]) {
      expect(parseCredential(value)).toMatchObject({ status: 'present' });
    }
  });

  it('reads the two lines aperture clients send, joined by Headers.get, and refuses two different credentials', () => {
    expect(parseCredential(`LSAT ${macaroon}:${preimage}, L402 ${macaroon}:${preimage}`)).toMatchObject({ status: 'present' });
    expect(parseCredential(`LSAT ${macaroon}:${preimage}, L402 ${macaroon}:${'cd'.repeat(32)}`)).toEqual({
      status: 'invalid',
      reason: 'conflicting_credentials',
    });
  });

  it('treats other schemes as absent, and finds L402 next to them', () => {
    expect(parseCredential('Bearer abc')).toEqual({ status: 'absent' });
    expect(parseCredential(undefined)).toEqual({ status: 'absent' });
    expect(parseCredential(`Bearer abc, L402 ${macaroon}:${preimage}`)).toMatchObject({ status: 'present' });
  });

  it('accepts URL-safe base64 and rejects malformed or multi-macaroon credentials', () => {
    expect(parseCredential(`L402 ${macaroon.replace('=', '')}:${preimage}`)).toMatchObject({ status: 'present' });
    expect(parseCredential('L402')).toEqual({ status: 'invalid', reason: 'malformed_credential' });
    expect(parseCredential(`L402 ${macaroon}:${preimage.slice(2)}`)).toEqual({ status: 'invalid', reason: 'malformed_credential' });
    expect(parseCredential(`L402 ${macaroon},${macaroon}:${preimage}`)).toEqual({ status: 'invalid', reason: 'multiple_macaroons_unsupported' });
  });
});

describe('BOLT 11 human-readable part', () => {
  it('reads network and amount', () => {
    expect(describeInvoice('lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqf')).toEqual({ network: 'mainnet', amountMsat: 250_000_000n });
    expect(describeInvoice('lntb20m1pvjluezhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs')).toEqual({ network: 'testnet', amountMsat: 2_000_000_000n });
    expect(describeInvoice('lntbs10n1qqqq')).toEqual({ network: 'signet', amountMsat: 1_000n });
    expect(describeInvoice('lnbcrt15p1qqqq')).toBeUndefined();
    expect(describeInvoice('lnbcrt150p1qqqq')).toEqual({ network: 'regtest', amountMsat: 15n });
    expect(describeInvoice('lnbc1pvjluezpp5')).toEqual({ network: 'mainnet', amountMsat: undefined });
    expect(describeInvoice('lnxyz1qqqq')).toBeUndefined();
  });
});
