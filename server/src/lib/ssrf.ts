// SSRF guard for the external-URL proxy: refuse private, loopback, link-local, CGNAT, multicast
// and other non-public targets. Checked when the URL is saved and again at connect time on every
// proxied request (via a guarded DNS lookup, so DNS rebinding cannot swap in a private address).
// ALLOW_PRIVATE_PROXY=1 disables the guard (local development against localhost apps).
import dns from 'node:dns';
import net from 'node:net';

export const privateProxyAllowed = () => process.env.ALLOW_PRIVATE_PROXY === '1';

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function expandV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return parts.length === 8 && parts.every((x) => x >= 0 && x <= 0xffff) ? parts : undefined;
}

/** True for any address that is not a normal public unicast address. */
export function isPrivateAddress(ip: string): boolean {
  const fam = net.isIP(ip.replace(/^\[|\]$/g, '').split('%')[0]);
  if (fam === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits))) || n === 0xffffffff;
  }
  if (fam !== 6) return true; // not an IP: treat as unsafe
  const p = expandV6(ip);
  if (!p) return true;
  if (p.every((x) => x === 0)) return true; // ::
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96): check the embedded IPv4.
  const embedded = `${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`;
  if (p.slice(0, 5).every((x) => x === 0) && (p[5] === 0xffff || p[5] === 0)) return isPrivateAddress(embedded);
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(embedded);
  if ((p[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((p[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((p[0] & 0xff00) === 0xff00) return true; // multicast
  if (p[0] === 0x2001 && p[1] === 0xdb8) return true; // documentation
  return false;
}

export class SsrfError extends Error {}

/** Resolve a URL's host and refuse non-public targets. Throws SsrfError with a researcher-readable message. */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (privateProxyAllowed()) return;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError('Only http(s) URLs can be proxied');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new SsrfError(`${host} is a private address and cannot be proxied`);
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch (e) {
      throw new SsrfError(`Could not resolve ${host} (${(e as NodeJS.ErrnoException).code || 'DNS error'})`);
    }
  }
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new SsrfError(`${host} resolves to a private or internal address (${bad}) and cannot be proxied. Set ALLOW_PRIVATE_PROXY=1 for local development.`);
}

/** A dns.lookup replacement for http(s).request: refuses private addresses at connect time. */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string | dns.LookupAddress[], f?: number) => void)(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = privateProxyAllowed() ? undefined : list.find((a) => isPrivateAddress(a.address));
    const cb = callback as (e: Error | null, a: string | dns.LookupAddress[], f?: number) => void;
    if (bad) return cb(new SsrfError(`${hostname} resolves to a private address (${bad.address})`), '', 0);
    if ((options as dns.LookupOptions).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
};
