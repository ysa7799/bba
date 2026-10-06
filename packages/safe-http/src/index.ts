import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound HTTP to customer-chosen URLs (workflow webhook actions, outbound webhooks), hardened
 * against SSRF: https only, no credentials in the URL, no redirects, and every address the host
 * name resolves to (checked at connect time, so DNS rebinding cannot swap in another one) must
 * be public. Private, loopback, link-local, carrier-grade NAT, multicast and reserved ranges
 * are refused.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** True for addresses on the public internet. IPv4-mapped IPv6 is checked as IPv4. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class HttpRequestError extends Error {
  constructor(
    message: string,
    /** Worth retrying later (timeouts, 5xx, 429). */
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface PostJsonOptions {
  /** Development and tests only: allow http and private addresses (e.g. a local receiver). */
  allowPrivateNetwork?: boolean;
  /** Overall limit for the whole exchange (connect, send, answer), in milliseconds. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Tests: substitute DNS resolution. */
  resolver?: Resolver;
  ownHosts?: readonly string[];
  userAgent?: string;
}

/** Validates a destination URL (also used when a workflow or a webhook endpoint is saved). */
export function checkWebhookUrl(
  raw: string,
  allowPrivateNetwork = false,
  /** BusinessOS's own host names: calling them could start a loop. */
  ownHosts: readonly string[] = [],
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpRequestError('Invalid URL', false);
  }
  if (url.protocol !== 'https:' && !(allowPrivateNetwork && url.protocol === 'http:')) {
    throw new HttpRequestError('Only https:// URLs are allowed', false);
  }
  if (url.username || url.password) {
    throw new HttpRequestError('Credentials are not allowed in the URL', false);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !allowPrivateNetwork && !isPublicAddress(host)) {
    throw new HttpRequestError('This address is not reachable from BusinessOS', false);
  }
  if (!allowPrivateNetwork && (host === 'localhost' || host.endsWith('.localhost'))) {
    throw new HttpRequestError('This address is not reachable from BusinessOS', false);
  }
  if (ownHosts.some((own) => own.toLowerCase() === host.toLowerCase())) {
    throw new HttpRequestError('This URL points at BusinessOS itself', false);
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** Resolves every address of a host name (replaceable in tests). */
export type Resolver = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: Resolver = (hostname, callback) => {
  dnsLookup(hostname, { all: true }, callback);
};

/** A connect-time `lookup` that only ever returns public addresses. */
export function guardedLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    resolver(hostname, (error, addresses) => {
      if (error) return callback(error, '');
      if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
        const refused = new Error(
          'This address is not reachable from BusinessOS',
        ) as NodeJS.ErrnoException;
        refused.code = 'EADDRNOTPUBLIC';
        return callback(refused, '');
      }
      if (options.all) return callback(null, addresses);
      const [first] = addresses;
      return callback(null, first?.address ?? '', first?.family);
    });
  };
}

/** POSTs JSON and resolves with the status; 2xx is success, anything else throws. */
export function postJson(
  rawUrl: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<{ status: number; durationMs: number }> {
  return postBody(rawUrl, JSON.stringify(body), options);
}

/**
 * POSTs an exact JSON text (callers that sign the body send the very bytes they signed) and
 * resolves with the status and duration; 2xx is success, anything else throws. The answer's
 * body is discarded.
 */
export function postBody(
  rawUrl: string,
  text: string,
  options: PostJsonOptions = {},
): Promise<{ status: number; durationMs: number }> {
  const allowPrivate = options.allowPrivateNetwork ?? false;
  const url = checkWebhookUrl(rawUrl, allowPrivate, options.ownHosts);
  const payload = Buffer.from(text);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const requestOptions: RequestOptions = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(payload.length),
      'user-agent': options.userAgent ?? 'BusinessOS-Automation/1',
      ...options.headers,
    },
    timeout: timeoutMs,
    ...(allowPrivate ? {} : { lookup: guardedLookup(options.resolver) }),
  };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = request(url, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      // The body is not used; drain it so the socket is released.
      response.resume();
      response.on('end', () => {
        clearTimeout(deadline);
        const durationMs = Date.now() - started;
        if (status >= 200 && status < 300) resolve({ status, durationMs });
        else {
          const retryable = status >= 500 || status === 408 || status === 429;
          reject(new HttpRequestError(`The endpoint answered ${status}`, retryable, status));
        }
      });
    });
    // `timeout` above is per socket inactivity; this bounds the whole exchange (a slow drip
    // of bytes cannot hold a worker forever).
    const deadline = setTimeout(() => {
      req.destroy(new HttpRequestError('The endpoint did not answer in time', true));
    }, timeoutMs);
    req.on('timeout', () => {
      req.destroy(new HttpRequestError('The endpoint did not answer in time', true));
    });
    req.on('error', (error) => {
      clearTimeout(deadline);
      if (error instanceof HttpRequestError) return reject(error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRNOTPUBLIC') {
        return reject(new HttpRequestError(error.message, false));
      }
      reject(new HttpRequestError(`Could not reach the endpoint (${code ?? 'error'})`, true));
    });
    req.end(payload);
  });
}
