import type { Rail } from 'tollstile';
import type { ProxyOptions } from './proxy';

/** What `tollstile-proxy --config <file>` loads: the proxy options plus where to listen. */
export type ProxyConfig<Rails extends readonly Rail[] = readonly Rail[]> = ProxyOptions<Rails> & {
  /** Defaults to 8402, or the PORT environment variable. */
  readonly port?: number;
  /** Defaults to 0.0.0.0. */
  readonly hostname?: string;
};

/** Types a proxy config file. Returns it unchanged. */
export function defineProxyConfig<const Rails extends readonly Rail[]>(config: ProxyConfig<Rails>): ProxyConfig<Rails> {
  return config;
}
