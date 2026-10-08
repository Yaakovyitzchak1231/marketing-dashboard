import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/dashboard/load', () => ({
  getDashboardData: vi.fn(async (range: string) => ({ range: { key: range }, configured: false })),
}))
import { NextRequest } from 'next/server'
import { GET } from '@/app/api/dashboard/route'
import { getDashboardData } from '@/lib/dashboard/load'

describe('GET /api/dashboard', () => {
  it('defaults to 30d', async () => {
    const res = await GET(new NextRequest('http://localhost/api/dashboard'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ range: { key: '30d' }, configured: false })
  })
  it('passes a valid range through', async () => {
    await GET(new NextRequest('http://localhost/api/dashboard?range=7d'))
    expect(getDashboardData).toHaveBeenLastCalledWith('7d')
  })
  it('rejects an unknown range with 400', async () => {
    const res = await GET(new NextRequest('http://localhost/api/dashboard?range=365d'))
    expect(res.status).toBe(400)
  })
  it('502 with plain words if loading throws, and logs the cause server-side', async () => {
    const err = new Error('boom')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getDashboardData).mockRejectedValueOnce(err)
    const res = await GET(new NextRequest('http://localhost/api/dashboard'))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/Could not load/)
    expect(JSON.stringify(body)).not.toContain('boom')
    expect(spy).toHaveBeenCalledWith('[dashboard] load failed', err)
    spy.mockRestore()
  })
})
