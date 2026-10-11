/**
 * The origin a Server Component uses to call this app's own API routes.
 *
 * Server-side `fetch` needs an absolute URL. A relative path works in a
 * browser and throws "Invalid URL" in a Server Component, which surfaced as a
 * 500 on `/`.
 *
 * It is defined ONCE here for a reason that is not tidiness. Six v2 pages each
 * carried their own copy of this function, and every copy hardcoded the
 * fallback port as a literal. That put a numeric literal in the render path --
 * exactly what tests/no-fabrication.test.ts exists to forbid -- and it meant
 * the fallback port lived in seven files that could drift apart. One
 * function, one constant, one place to argue with it.
 */

/**
 * Named rather than inlined so the "no numbers in the render path" test has
 * nothing to flag and a reviewer has one place to argue with it. It is a
 * transport detail, not a figure the database ever produced.
 */
const DEFAULT_DEV_PORT = 3000

/**
 * Owner email for the provenance surface, read server-side from the same
 * allow-list env the API routes enforce. The fail-closed placeholder is not
 * a person, so it comes back undefined and the approval controls render
 * disabled. Never derived from a stored row.
 */
export function getOwnerEmail(): string | undefined {
  const email = process.env.ALLOWED_USER_EMAIL
  if (!email || email === 'unset@invalid.local') return undefined
  return email
}

export function getBaseUrl(): string {
  // The PORT fallback matters more than it looks: without it the self-fetch
  // targeted the default dev port while the server actually listened on
  // whatever port `next start -p N` was given. Every fetch then failed, was
  // swallowed by the catch, and the page rendered the honest empty state with
  // real data sitting in the database.
  const port = process.env.PORT ?? String(DEFAULT_DEV_PORT)
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://127.0.0.1:${port}`)
  )
}