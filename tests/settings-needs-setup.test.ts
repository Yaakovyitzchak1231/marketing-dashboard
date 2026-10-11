import { describe, expect, it } from 'vitest'
import { isFieldSet, needsSetup, settingAnchor, type SetupField } from '@/lib/settings/needs-setup'
import { taskKindOptions, TASK_KINDS } from '@/lib/settings/task-kinds'
import { settingSpec, settingsByGroup } from '@/lib/settings/registry'

describe('settingAnchor', () => {
  it('is stable and URL-safe', () => {
    expect(settingAnchor('mail.api_key')).toBe('setting-mail-api-key')
    expect(settingAnchor('workspace.quiet_hours_start')).toBe('setting-workspace-quiet-hours-start')
  })
})

describe('isFieldSet / needsSetup', () => {
  const env = { MAIL_API_KEY: 'x', EMPTY: '   ' }
  it('a secret counts as set when saved OR its env fallback is non-empty', () => {
    expect(isFieldSet({ key: 'a', label: 'A', group: 'G', secret: true, secretSet: true }, {})).toBe(true)
    expect(isFieldSet({ key: 'mail.api_key', label: 'K', group: 'G', secret: true, envFallback: 'MAIL_API_KEY', secretSet: false }, env)).toBe(true)
    expect(isFieldSet({ key: 'b', label: 'B', group: 'G', secret: true, envFallback: 'EMPTY', secretSet: false }, env)).toBe(false)
  })
  it('a plain setting counts as set with a non-empty saved value or env fallback', () => {
    expect(isFieldSet({ key: 'c', label: 'C', group: 'G', secret: false, value: 'resend' }, {})).toBe(true)
    expect(isFieldSet({ key: 'c', label: 'C', group: 'G', secret: false, value: '  ' }, {})).toBe(false)
    expect(isFieldSet({ key: 'c', label: 'C', group: 'G', secret: false, value: null }, {})).toBe(false)
  })
  it('lists only what is missing, in order, with anchors and the optional flag', () => {
    const fields: SetupField[] = [
      { key: 'mail.provider', label: 'Mail provider', group: 'Email sending', secret: false, value: 'resend' },
      { key: 'mail.api_key', label: 'Mail API key', group: 'Email sending', secret: true, secretSet: false },
      { key: 'ai.api_key', label: 'AI key', group: 'AI', secret: true, secretSet: false, optional: true },
    ]
    expect(needsSetup(fields, {})).toEqual([
      { key: 'mail.api_key', label: 'Mail API key', group: 'Email sending', anchor: 'setting-mail-api-key', optional: false },
      { key: 'ai.api_key', label: 'AI key', group: 'AI', anchor: 'setting-ai-api-key', optional: true },
    ])
  })
})

describe('registry: Email sending group and Mail provider options', () => {
  it('mail fields live together under "Email sending", and Mail provider is a fixed choice', () => {
    const g = settingsByGroup().find((x) => x.group === 'Email sending')!
    expect(g.items.map((i) => i.key)).toEqual(['mail.provider', 'mail.api_key', 'mail.from'])
    const p = settingSpec('mail.provider')!
    expect(p.options?.map((o) => o.value)).toEqual(['resend', 'brevo'])
    expect(p.validate?.('Resend')).toBeNull()
    expect(p.validate?.('mailgun')).toMatch(/Resend or Brevo/)
    expect(settingSpec('mail.api_key')!.help).toMatch(/Resend or Brevo/)
  })
})

describe('taskKindOptions', () => {
  it('known kinds first, plus any saved kind not in the list', () => {
    const opts = taskKindOptions(['find_leads', 'odd_kind'])
    expect(opts.slice(0, TASK_KINDS.length)).toEqual(TASK_KINDS)
    expect(opts.map((o) => o.value)).toContain('odd_kind')
    expect(opts.filter((o) => o.value === 'find_leads')).toHaveLength(1)
  })
})
