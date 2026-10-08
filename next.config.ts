import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework in every response header.
  poweredByHeader: false,
  // Pin file tracing to this project. Without it, Next walks up the directory
  // tree looking for a lockfile and may pick a parent folder's (e.g. a home
  // directory with its own package-lock.json) as the workspace root.
  outputFileTracingRoot: __dirname,
}

export default nextConfig
