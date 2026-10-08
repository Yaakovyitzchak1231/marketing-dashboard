import { promises as dns } from 'node:dns'

/** MX hosts for a domain: string[] (maybe empty), 'nxdomain', or 'error'. 6 s deadline. */
export async function mxLookup(domain: string, timeoutMs = 6000): Promise<string[] | 'nxdomain' | 'error'> {
  const t = new Promise<'error'>((r) => setTimeout(() => r('error'), timeoutMs))
  const q = dns
    .resolveMx(domain)
    .then((a) => a.sort((x, y) => x.priority - y.priority).map((m) => m.exchange).slice(0, 3))
    .catch((e: NodeJS.ErrnoException) => (e.code === 'ENOTFOUND' ? ('nxdomain' as const) : e.code === 'ENODATA' ? [] : ('error' as const)))
  return Promise.race([q, t])
}
