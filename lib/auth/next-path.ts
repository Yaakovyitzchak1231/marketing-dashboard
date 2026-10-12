/**
 * The `?next=` value carried from a protected page to /login and back.
 *
 * Read on both sides: the middleware only ever writes pathname + search, but
 * the login page reads `next` from a URL anyone can craft, so an unchecked
 * value would be an open redirect (`//evil.com`, `/\evil.com`, `/%2f%2fevil`,
 * `https://evil.com`). Only a same-origin, path-absolute value survives;
 * anything else returns null and the caller falls back to `/`.
 *
 * Pure, no server-only imports: middleware (Edge) and the client page share it.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  // Control characters, backslashes, encoded slashes/backslashes/NUL, and any
  // `//` anywhere: each is a way to make a browser treat the value as a host.
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || /%5c|%2f|%00/i.test(raw) || raw.includes('//')) return null
  const pathOnly = raw.split(/[?#]/)[0]
  if (pathOnly.includes(':')) return null
  // Never bounce back to the login page itself (loop) or to an API route.
  // Trailing slashes and fragments are normalised away first, so `/login/`
  // and `/login#x` are caught too.
  const p = pathOnly.replace(/\/+$/, '') || '/'
  if (p === '/login' || p.startsWith('/login/') || p === '/api' || p.startsWith('/api/')) return null
  return raw
}
