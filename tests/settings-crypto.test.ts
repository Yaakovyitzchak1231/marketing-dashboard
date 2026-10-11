import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { decryptSecret, encryptSecret, loadSettingsKey, settingsKeyConfigured, SettingsKeyError, SecretDecryptError } from '@/lib/settings/crypto'

const KEY_B64 = Buffer.alloc(32, 7).toString('base64')
const KEY_HEX = Buffer.alloc(32, 9).toString('hex')
const env = (key?: string) => (key ? { SETTINGS_KEY: key } : {})

describe('settings crypto: AES-256-GCM', () => {
  it('round-trips a value with a base64 key', () => {
    const enc = encryptSecret('sk-super-secret-123', env(KEY_B64))
    expect(enc.last4).toBe('-123')
    expect(decryptSecret(enc, env(KEY_B64))).toBe('sk-super-secret-123')
  })

  it('round-trips with a hex key too, and accepts either shape', () => {
    const enc = encryptSecret('hunter2', env(KEY_HEX))
    expect(decryptSecret(enc, env(KEY_HEX))).toBe('hunter2')
  })

  it('two encrypts of the same plaintext produce different ciphertext and iv (fresh random IV)', () => {
    const a = encryptSecret('same-value', env(KEY_B64))
    const b = encryptSecret('same-value', env(KEY_B64))
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('tamper detection: a flipped ciphertext byte fails to decrypt', () => {
    const enc = encryptSecret('tamper-me', env(KEY_B64))
    const bytes = Buffer.from(enc.ciphertext, 'base64')
    bytes[0] ^= 0xff
    const tampered = { ...enc, ciphertext: bytes.toString('base64') }
    expect(() => decryptSecret(tampered, env(KEY_B64))).toThrow(SecretDecryptError)
  })

  it('tamper detection: a flipped auth tag byte fails to decrypt', () => {
    const enc = encryptSecret('tamper-tag', env(KEY_B64))
    const bytes = Buffer.from(enc.tag, 'base64')
    bytes[0] ^= 0xff
    const tampered = { ...enc, tag: bytes.toString('base64') }
    expect(() => decryptSecret(tampered, env(KEY_B64))).toThrow(SecretDecryptError)
  })

  it('the wrong key fails to decrypt', () => {
    const enc = encryptSecret('right-key-only', env(KEY_B64))
    const otherKey = Buffer.alloc(32, 42).toString('base64')
    expect(() => decryptSecret(enc, env(otherKey))).toThrow(SecretDecryptError)
  })

  it('a swapped iv/ciphertext pair (mismatched row) fails to decrypt', () => {
    const a = encryptSecret('value-a', env(KEY_B64))
    const b = encryptSecret('value-b', env(KEY_B64))
    const swapped = { ciphertext: a.ciphertext, iv: b.iv, tag: a.tag }
    expect(() => decryptSecret(swapped, env(KEY_B64))).toThrow(SecretDecryptError)
  })

  it('missing SETTINGS_KEY throws a clear, secret-free error', () => {
    expect(() => loadSettingsKey(env(undefined))).toThrow(SettingsKeyError)
    expect(() => loadSettingsKey(env(undefined))).toThrow(/SETTINGS_KEY is not set/)
    expect(settingsKeyConfigured(env(undefined))).toBe(false)
  })

  it('a key that does not decode to exactly 32 bytes throws', () => {
    const short = Buffer.alloc(16, 1).toString('base64')
    expect(() => loadSettingsKey(env(short))).toThrow(SettingsKeyError)
    expect(() => loadSettingsKey(env(short))).toThrow(/32 bytes/)
  })

  it('garbage that is not valid base64/hex throws cleanly', () => {
    expect(() => loadSettingsKey(env('not base64 or hex!! @@'))).toThrow(SettingsKeyError)
  })

  it('settingsKeyConfigured is true for a well-formed key', () => {
    expect(settingsKeyConfigured(env(KEY_B64))).toBe(true)
  })
})
