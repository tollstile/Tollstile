export type Bytes = Uint8Array<ArrayBuffer>;

export type Caveat = {
  readonly id: Bytes;
  /** Empty for first-party caveats, the only kind L402 uses. */
  readonly verificationId: Bytes;
  /** Unsigned hint; empty when absent. */
  readonly location: Bytes;
};

/** A macaroon in the V2 binary format of gopkg.in/macaroon.v2 and libmacaroons, which aperture and lnget use. */
export type Macaroon = {
  /** Unsigned hint; empty when absent. */
  readonly location: Bytes;
  readonly identifier: Bytes;
  readonly caveats: readonly Caveat[];
  readonly signature: Bytes;
};

const VERSION_V2 = 2;
const FIELD = { eos: 0, location: 1, identifier: 2, verificationId: 4, signature: 6 } as const;
const SIGNATURE_LENGTH = 32;
const encoder = new TextEncoder();
/**
 * libmacaroons and go-macaroon derive the chain key from the root key with this constant. The L402
 * macaroon-spec prose omits the step; the libraries clients actually use apply it.
 */
const KEY_GENERATOR = encoder.encode('macaroons-key-generator');

export async function mintMacaroon(rootKey: Bytes, identifier: Bytes, caveats: readonly string[]): Promise<Macaroon> {
  let signature = await hmac(await hmac(KEY_GENERATOR, rootKey), identifier);
  const firstParty: Caveat[] = [];
  for (const caveat of caveats) {
    const id = encoder.encode(caveat);
    signature = await hmac(signature, id);
    firstParty.push({ id, verificationId: new Uint8Array(0), location: new Uint8Array(0) });
  }
  return { location: new Uint8Array(0), identifier, caveats: firstParty, signature };
}

/**
 * Recomputes the HMAC chain and compares the final step in constant time. Third-party caveats
 * need discharge macaroons, which L402 never issues, so a macaroon carrying one does not verify.
 */
export async function verifyMacaroon(rootKey: Bytes, macaroon: Macaroon): Promise<boolean> {
  if (macaroon.caveats.some((caveat) => caveat.verificationId.length > 0)) return false;

  let key = await hmac(KEY_GENERATOR, rootKey);
  let message = macaroon.identifier;
  for (const caveat of macaroon.caveats) {
    key = await hmac(key, message);
    message = caveat.id;
  }
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', cryptoKey, macaroon.signature, message);
}

export function encodeMacaroon(macaroon: Macaroon): Bytes {
  const out: number[] = [VERSION_V2];
  const packet = (field: number, data: Uint8Array) => {
    out.push(...varint(field), ...varint(data.length), ...data);
  };

  if (macaroon.location.length > 0) packet(FIELD.location, macaroon.location);
  packet(FIELD.identifier, macaroon.identifier);
  out.push(FIELD.eos);
  for (const caveat of macaroon.caveats) {
    if (caveat.location.length > 0) packet(FIELD.location, caveat.location);
    packet(FIELD.identifier, caveat.id);
    if (caveat.verificationId.length > 0) packet(FIELD.verificationId, caveat.verificationId);
    out.push(FIELD.eos);
  }
  out.push(FIELD.eos);
  packet(FIELD.signature, macaroon.signature);
  return Uint8Array.from(out);
}

type Packet = { readonly field: number; readonly data: Bytes };

/** Parses exactly one V2 macaroon, following go-macaroon's rules. Returns undefined for anything else. */
export function decodeMacaroon(bytes: Bytes): Macaroon | undefined {
  if (bytes[0] !== VERSION_V2) return undefined;
  const reader = { bytes, offset: 1 };

  const header = readSection(reader);
  if (header === undefined) return undefined;
  const [location, headerRest] = takeLocation(header);
  const identifier = headerRest[0];
  if (headerRest.length !== 1 || identifier?.field !== FIELD.identifier) return undefined;

  const caveats: Caveat[] = [];
  for (;;) {
    const section = readSection(reader);
    if (section === undefined) return undefined;
    if (section.length === 0) break;

    const [caveatLocation, rest] = takeLocation(section);
    const [id, verificationId, ...extra] = rest;
    if (id?.field !== FIELD.identifier || extra.length > 0) return undefined;
    if (verificationId === undefined) {
      if (caveatLocation.length > 0) return undefined;
      caveats.push({ id: id.data, verificationId: new Uint8Array(0), location: caveatLocation });
      continue;
    }
    if (verificationId.field !== FIELD.verificationId) return undefined;
    caveats.push({ id: id.data, verificationId: verificationId.data, location: caveatLocation });
  }

  const signature = readPacket(reader);
  if (signature?.field !== FIELD.signature || signature.data.length !== SIGNATURE_LENGTH) return undefined;
  if (reader.offset !== bytes.length) return undefined;
  return { location, identifier: identifier.data, caveats, signature: signature.data };
}

export async function hmac(key: Bytes, message: Bytes): Promise<Bytes> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message));
}

type Reader = { readonly bytes: Bytes; offset: number };

function readSection(reader: Reader): Packet[] | undefined {
  const packets: Packet[] = [];
  for (;;) {
    const packet = readPacket(reader);
    if (packet === undefined) return undefined;
    if (packet.field === FIELD.eos) return packets;
    const previous = packets.at(-1);
    if (previous !== undefined && packet.field <= previous.field) return undefined;
    packets.push(packet);
  }
}

function readPacket(reader: Reader): Packet | undefined {
  const field = readVarint(reader);
  if (field === undefined) return undefined;
  if (field === FIELD.eos) return { field, data: new Uint8Array(0) };
  const length = readVarint(reader);
  if (length === undefined || reader.offset + length > reader.bytes.length) return undefined;
  const data = reader.bytes.slice(reader.offset, reader.offset + length);
  reader.offset += length;
  return { field, data };
}

function takeLocation(packets: readonly Packet[]): [Bytes, readonly Packet[]] {
  const first = packets[0];
  if (first?.field !== FIELD.location) return [new Uint8Array(0), packets];
  return [first.data, packets.slice(1)];
}

/** Unsigned LEB128, capped at 2^31 - 1 like go-macaroon. */
function readVarint(reader: Reader): number | undefined {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = reader.bytes[reader.offset];
    if (byte === undefined) return undefined;
    reader.offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return value <= 0x7fffffff ? value : undefined;
  }
  return undefined;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}
