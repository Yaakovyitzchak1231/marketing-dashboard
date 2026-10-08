import 'server-only'
import type { DashboardData } from '@/lib/dashboard/types'

/**
 * DEV-ONLY sample data, for screenshots and local UI work before a key exists.
 *
 * Returns null unless BOTH:
 *   - NODE_ENV is not 'production' (Next inlines NODE_ENV at build time, so in a
 *     production build this whole function body is dead code), AND
 *   - DASHBOARD_SAMPLE=1 is set.
 * The fixture lives under tests/fixtures/ and is read from disk at request time,
 * so it is never bundled into the app and is not deployed with it.
 * The page shows a loud "SAMPLE DATA" banner whenever this returns data.
 */
export async function loadSampleData(env: { NODE_ENV?: string; DASHBOARD_SAMPLE?: string } = process.env): Promise<DashboardData | null> {
  if (process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production') return null
  if (env.DASHBOARD_SAMPLE !== '1') return null
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const raw = await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'dashboard.sample.json'), 'utf8')
  return JSON.parse(raw) as DashboardData
}
