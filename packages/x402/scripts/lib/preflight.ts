import { toAssetUnits, type Money } from 'tollstile';
import { KNOWN_NETWORKS, PERMIT2_ADDRESS, UPTO_PROXY_ADDRESS, type X402Asset } from '../../src/networks';
import { Rpc, sameAddress } from './rpc';

/**
 * Everything that can be wrong before a signature exists, checked in one pass.
 *
 * A run that stops here has spent nothing and signed nothing. Each failure names what is missing
 * and how to supply it, because the person reading it is usually holding a faucet page.
 */

export type Preflight = {
  readonly asset: X402Asset;
  /** Read from the facilitator's own `/supported`, never from configuration. */
  readonly facilitatorAddress: string;
};

export async function preflight(options: {
  readonly network: string;
  readonly rpcUrl: string;
  readonly facilitatorUrl: string;
  readonly payer: string;
  readonly payTo: string;
  /** What the whole run may spend, at most. */
  readonly spend: Money;
}): Promise<Preflight> {
  const problems: string[] = [];
  const known = KNOWN_NETWORKS[options.network];
  if (known === undefined) throw new Error(`This harness knows ${Object.keys(KNOWN_NETWORKS).join(' and ')}, not ${options.network}.`);
  if (!known.testnet) throw new Error(`${options.network} is a mainnet. This harness signs real payments and only runs on a testnet.`);
  const asset = known.asset;

  const spend = toAssetUnits(options.spend, asset.decimals);
  const rpc = new Rpc(options.rpcUrl);
  const chainId = await rpc.chainId();
  const expected = BigInt(options.network.split(':')[1] ?? '0');
  if (chainId !== expected) problems.push(`the JSON-RPC endpoint is chain ${String(chainId)}, but ${options.network} is chain ${String(expected)}.`);

  const decimals = await rpc.decimals(asset.address);
  if (decimals !== asset.decimals) problems.push(`${asset.address} reports ${String(decimals)} decimals, but the rail is configured for ${String(asset.decimals)}.`);

  if (sameAddress(options.payer, options.payTo)) problems.push('the payer and the receiver are the same address; a transfer to yourself proves nothing.');

  const balance = await rpc.tokenBalance(asset.address, options.payer);
  if (balance < spend) {
    problems.push(
      `the payer holds ${units(balance, asset)} ${asset.code} and the run may spend ${units(spend, asset)}. Fund it at https://faucet.circle.com.`,
    );
  }

  const allowance = await rpc.allowance(asset.address, options.payer, PERMIT2_ADDRESS);
  if (allowance < spend) {
    problems.push(
      `the payer has approved Permit2 (${PERMIT2_ADDRESS}) for ${units(allowance, asset)} ${asset.code}. ` +
        `The upto scheme moves money through ${UPTO_PROXY_ADDRESS} as a Permit2 spender, so approve at least ${units(spend, asset)} once.`,
    );
  }

  const native = await rpc.nativeBalance(options.payer);
  if (native === 0n && allowance < spend) problems.push('the payer holds no ETH, so it cannot send the one-time Permit2 approval transaction.');

  const facilitatorAddress = await uptoFacilitatorAddress(options.facilitatorUrl, options.network, problems);

  if (problems.length > 0) throw new Error(`Preflight stopped the run:\n${problems.map((problem) => `  · ${problem}`).join('\n')}`);
  if (facilitatorAddress === undefined) throw new Error('unreachable: a missing facilitator address is a problem');
  return { asset, facilitatorAddress };
}

/**
 * The address payers bind an `upto` signature to. It is the facilitator's, it has moved before, and
 * signing against a stale one fails at settlement, after the service was delivered. So it is read
 * here and never taken from configuration.
 */
async function uptoFacilitatorAddress(facilitatorUrl: string, network: string, problems: string[]): Promise<string | undefined> {
  const response = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/supported`);
  if (!response.ok) {
    problems.push(`GET ${facilitatorUrl}/supported answered ${String(response.status)}.`);
    return undefined;
  }
  const body: unknown = await response.json();
  const kinds = Array.isArray((body as { kinds?: unknown }).kinds) ? ((body as { kinds: unknown[] }).kinds) : undefined;
  if (kinds === undefined) {
    problems.push(`GET ${facilitatorUrl}/supported did not answer with a "kinds" array; this harness cannot tell what it settles.`);
    return undefined;
  }
  const entries = kinds.map((kind) => kind as { scheme?: unknown; network?: unknown; extra?: { facilitatorAddress?: unknown } });
  const schemes = new Set(entries.filter((kind) => kind.network === network).map((kind) => String(kind.scheme)));
  if (!schemes.has('exact')) problems.push(`the facilitator does not list the exact scheme for ${network}.`);
  const upto = entries.find((kind) => kind.network === network && kind.scheme === 'upto');
  if (upto === undefined) {
    problems.push(`the facilitator does not list the upto scheme for ${network}, which is what this run verifies.`);
    return undefined;
  }
  const address = upto.extra?.facilitatorAddress;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    problems.push(`the facilitator lists upto for ${network} without a usable extra.facilitatorAddress.`);
    return undefined;
  }
  return address;
}

function units(amount: bigint, asset: X402Asset): string {
  const scale = 10n ** BigInt(asset.decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(asset.decimals, '0');
  return `${String(whole)}.${fraction}`;
}
