/**
 * AES-256-GCM for everything stored in lp.secrets.
 *
 * The key is SETTINGS_KEY: 32 raw bytes, given as base64 or hex. A fresh random
 * 12-byte IV is generated for every encrypt call and stored alongside the
 * ciphertext and the GCM auth tag, so decryption both decrypts AND verifies
 * nothing was tampered with (a flipped bit, a swapped row, the wrong key all
 * fail loudly instead of returning garbage).
 *
 * Nothing in this module ever logs a plaintext value.
 */
// Server-side only by construction (node:crypto); no `import 'server-only'` here so
// lib/ops/dispatch.ts -> SETTINGS_OPS stays importable in tests and scripts.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const KEY_BYTES = 32
const IV_BYTES = 12

export class SettingsKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsKeyError'
  }
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretDecryptError'
  }
}

type Env = Record<string, string | undefined>

/** A plain Uint8Array<ArrayBuffer> copy, so node:crypto's stricter TS overloads accept it regardless of exactly how the Buffer's own backing store is typed. */
function u8(b: Buffer): Uint8Array {
  return new Uint8Array(b)
}

/**
 * Decode SETTINGS_KEY into exactly 32 raw bytes. Accepts base64 (the
 * `openssl rand -base64 32` shape) or 64 hex characters. Throws a clear,
 * secret-free error when it is missing or does not decode to 32 bytes.
 */
export function loadSettingsKey(env: Env = process.env): Buffer {
  const raw = (env.SETTINGS_KEY ?? '').trim()
  if (!raw) {
    throw new SettingsKeyError(
      'SETTINGS_KEY is not set. Add it in Vercel (Settings → Environment Variables) before secrets can be saved here: 32 random bytes, e.g. `openssl rand -base64 32`.',
    )
  }
  const isHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length === KEY_BYTES * 2
  let buf: Buffer
  try {
    buf = isHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  } catch {
    throw new SettingsKeyError('SETTINGS_KEY is not valid base64 or hex.')
  }
  if (buf.length !== KEY_BYTES) {
    throw new SettingsKeyError(`SETTINGS_KEY must decode to exactly 32 bytes (got ${buf.length}). Generate one with \`openssl rand -base64 32\`.`)
  }
  return buf
}

/** Whether SETTINGS_KEY is present and well-formed, without throwing. */
export function settingsKeyConfigured(env: Env = process.env): boolean {
  try {
    loadSettingsKey(env)
    return true
  } catch {
    return false
  }
}

export interface EncryptedSecret {
  ciphertext: string // base64
  iv: string // base64
  tag: string // base64
  last4: string
}

/** The last 4 characters of a value, for display ("ends in …a1b2"). Never the value itself. */
export function last4Of(plaintext: string): string {
  return plaintext.slice(-4)
}

/** AES-256-GCM encrypt. A fresh random IV every call, so encrypting the same value twice looks different on disk. */
export function encryptSecret(plaintext: string, env: Env = process.env): EncryptedSecret {
  const key = loadSettingsKey(env)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', u8(key), u8(iv))
  // String in, string out (base64) on both update and final — sidesteps Buffer.concat, whose
  // array-element typing fights this TS lib target's newer ArrayBuffer shape against @types/node's Buffer.
  const ciphertext = cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64')
  const tag = cipher.getAuthTag()
  return { ciphertext, iv: iv.toString('base64'), tag: tag.toString('base64'), last4: last4Of(plaintext) }
}

export interface EncryptedSecretRow {
  ciphertext: string
  iv: string
  tag: string
}

/** AES-256-GCM decrypt + authenticate. Throws SecretDecryptError on any tamper (wrong key, flipped bit, mismatched row). */
export function decryptSecret(enc: EncryptedSecretRow, env: Env = process.env): string {
  const key = loadSettingsKey(env)
  try {
    const decipher = createDecipheriv('aes-256-gcm', u8(key), u8(Buffer.from(enc.iv, 'base64')))
    decipher.setAuthTag(u8(Buffer.from(enc.tag, 'base64')))
    return decipher.update(u8(Buffer.from(enc.ciphertext, 'base64')), undefined, 'utf8') + decipher.final('utf8')
  } catch {
    throw new SecretDecryptError('Could not decrypt this secret: it does not match SETTINGS_KEY (wrong key, or the stored value was tampered with).')
  }
}
