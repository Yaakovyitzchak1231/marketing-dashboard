import { describe, it, expect } from 'vitest'
import { normalizeDomain, normalizePhone, normalizeEmail, nameAddressKey, isRoleAddress } from '@/lib/leads/normalize'

describe('dedupe keys', () => {
  it('normalizes website domains', () => {
    expect(normalizeDomain('https://www.ShirinDiamond.com/en-us')).toBe('shirindiamond.com')
    expect(normalizeDomain('lorenzajewelry.com')).toBe('lorenzajewelry.com')
    expect(normalizeDomain('http://shop.example.co.uk:8080/x?y')).toBe('shop.example.co.uk')
    expect(normalizeDomain('https://www.facebook.com/somejeweler')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain('not a url')).toBeNull()
  })
  it('normalizes US phones to E.164', () => {
    expect(normalizePhone('(770)952-0030')).toBe('+17709520030')
    expect(normalizePhone('1-713-910-8887')).toBe('+17139108887')
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
    expect(normalizePhone('555-1234')).toBeNull()
    expect(normalizePhone('(410) 555-0100 ext 12')).toBe('+14105550100')
  })
  it('normalizes emails', () => {
    expect(normalizeEmail(' Owner@Store.COM ')).toBe('owner@store.com')
    expect(normalizeEmail('mailto:a@b.co')).toBe('a@b.co')
    expect(normalizeEmail('nope')).toBeNull()
  })
  it('builds a name+address key that ignores punctuation and suffixes', () => {
    expect(nameAddressKey('Smith & Sons Jewelers, LLC', null, 'Baltimore', 'MD')).toBe(nameAddressKey('smith and sons jewelers', '', 'baltimore', 'md'))
    expect(nameAddressKey('Smith', null, null, 'MD')).toBeNull()
  })
  it('flags role addresses', () => {
    expect(isRoleAddress('info@store.com')).toBe(true)
    expect(isRoleAddress('sales2@store.com')).toBe(true)
    expect(isRoleAddress('maria@store.com')).toBe(false)
  })
})
