import { describe, it, expect, vi } from 'vitest'
import { redirect } from 'next/navigation'

vi.mock('next/navigation')

import SetupPage from '@/app/setup/page'

describe('/setup redirect', () => {
  it('redirects to /settings', () => {
    const mockRedirect = vi.mocked(redirect)
    mockRedirect.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`)
    })

    expect(() => {
      SetupPage()
    }).toThrow('redirect:/settings')

    expect(mockRedirect).toHaveBeenCalledWith('/settings')
  })
})