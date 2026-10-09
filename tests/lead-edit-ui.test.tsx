// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { EditFields } from '@/components/leads/EditFields'
import { EDITABLE_CONTACT_STATUSES } from '@/lib/leads/edit-fields'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }) }))

function contactForm() {
  return render(
    <EditFields
      endpoint="/api/leads/7/contacts/9"
      title="contact info@gem.com"
      confirmEmailChange
      fields={[
        { name: 'first_name', label: 'First name', value: null },
        { name: 'email', label: 'Email', value: 'info@gem.com', type: 'email' },
        { name: 'status', label: 'Status', value: 'role-based-hold', type: 'select', options: EDITABLE_CONTACT_STATUSES },
      ]}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('EditFields (lead page edit form)', () => {
  it('opens on Edit, offers every status including role-based-hold, and sends only changed fields', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ changes: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    contactForm()
    fireEvent.click(screen.getByRole('button', { name: 'Edit contact info@gem.com' }))
    const status = screen.getByLabelText('Status') as HTMLSelectElement
    expect(status.value).toBe('role-based-hold')
    expect([...status.options].map((o) => o.value)).toEqual([...EDITABLE_CONTACT_STATUSES])
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Dana ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/leads/7/contacts/9')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ first_name: 'Dana' })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('asks before saving a changed email, and sends nothing if the person cancels', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    contactForm()
    fireEvent.click(screen.getByRole('button', { name: 'Edit contact info@gem.com' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dana@gem.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/resets its verification/))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the server's error and keeps the form open", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '"x@y" is not a valid email address.' }), { status: 400 })))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    contactForm()
    fireEvent.click(screen.getByRole('button', { name: 'Edit contact info@gem.com' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'x@y' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('"x@y" is not a valid email address.')
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })
})
