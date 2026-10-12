import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework in every response header.
  poweredByHeader: false,
  // Pin file tracing to this project. Without it, Next walks up the directory
  // tree looking for a lockfile and may pick a parent folder's (e.g. a home
  // directory with its own package-lock.json) as the workspace root.
  outputFileTracingRoot: __dirname,
  // Anti-framing (clickjacking on /login) and no MIME sniffing. Deliberately
  // NOT a full CSP: script-src without nonces would break Next's inline
  // hydration scripts, and connect-src would have to allow the Supabase
  // origin or sign-in dies. HSTS is Vercel's; not duplicated here.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ]
  },
}

export default nextConfig
