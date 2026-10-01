import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mockSignOut = vi.fn()
const mockSupabaseApi = {
  auth: {
    signOut: mockSignOut
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(() => mockSupabaseApi)
}))

import { POST as logoutPOST } from '@/app/api/auth/logout/route'

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns success when sign out is successful', async () => {
    mockSignOut.mockResolvedValue({ error: null })

    const request = new NextRequest(new URL('http://localhost/api/auth/logout'))
    const response = await logoutPOST(request)

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ success: true })
    expect(mockSignOut).toHaveBeenCalledOnce()
  })

  it('returns error 500 when sign out fails', async () => {
    mockSignOut.mockResolvedValue({ error: new Error('Failed') })

    const request = new NextRequest(new URL('http://localhost/api/auth/logout'))
    const response = await logoutPOST(request)

    expect(response.status).toBe(500)
    const data = await response.json()
    expect(data).toEqual({ error: 'Failed to sign out' })
    expect(mockSignOut).toHaveBeenCalledOnce()
  })
})
