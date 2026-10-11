import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUIET_END_KEY, QUIET_START_KEY } from '@/lib/settings/quiet-hours'
import { SETTINGS_REGISTRY } from '@/lib/settings/registry'

describe('quiet hours keys', () => {
  it('match registry keys', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key)
    expect(keys).toContain(QUIET_START_KEY)
    expect(keys).toContain(QUIET_END_KEY)
  })

  it('the server Settings page reads them from the plain module, not the client component', () => {
    // A constant exported from a 'use client' file reaches a server component as a
    // client reference, not a string, so the range row silently fell back to two text rows.
    const page = readFileSync(path.join(__dirname, '..', 'app/settings/page.tsx'), 'utf8')
    expect(page).toMatch(/import \{ QUIET_END_KEY, QUIET_START_KEY \} from '@\/lib\/settings\/quiet-hours'/)
    const field = readFileSync(path.join(__dirname, '..', 'components/settings/QuietHoursField.tsx'), 'utf8')
    expect(field).not.toMatch(/export const QUIET_/)
  })
})
