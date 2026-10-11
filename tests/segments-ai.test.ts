import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { extractJson, segmentFromText, SegmentAiError } from '@/lib/segments/ai'

function chatReturning(content: string) {
  return vi.fn(async () => content)
}

const CFG = { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'test-model' }

const VALID_DEFINITION = {
  entity: 'contact',
  include: [{ conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 2 }] }],
  exclude: [{ conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'gte', count: 1 }] }],
}

describe('segment "describe it" (plan 2.11)', () => {
  it('{configured:false} when no AI provider is set up -- never calls chat', async () => {
    const chat = chatReturning(JSON.stringify(VALID_DEFINITION))
    const r = await segmentFromText('opened twice, never replied', { config: null, chat })
    expect(r).toEqual({ configured: false, reason: 'no AI provider is configured' })
    expect(chat).not.toHaveBeenCalled()
  })

  it('a valid AI reply becomes a validated definition + readback', async () => {
    const chat = chatReturning(JSON.stringify(VALID_DEFINITION))
    const r = await segmentFromText('opened twice, never replied', { config: CFG, chat })
    expect(r.configured).toBe(true)
    if (r.configured) {
      expect(r.definition).toEqual(VALID_DEFINITION)
      expect(r.readback).toMatch(/opened/)
    }
  })

  it('a reply wrapped in a ```json fence still parses', async () => {
    const chat = chatReturning('```json\n' + JSON.stringify(VALID_DEFINITION) + '\n```')
    const r = await segmentFromText('opened twice, never replied', { config: CFG, chat })
    expect(r.configured).toBe(true)
  })

  it('invalid JSON from the model throws, never half-applies anything', async () => {
    const chat = chatReturning('not json at all')
    await expect(segmentFromText('x', { config: CFG, chat })).rejects.toThrow(SegmentAiError)
  })

  it('an unknown field key is rejected by the real validator, not silently dropped', async () => {
    const chat = chatReturning(JSON.stringify({
      entity: 'contact',
      include: [{ conditions: [{ kind: 'field', field: 'contact.favorite_color', op: 'is', value: 'blue' }] }],
      exclude: [],
    }))
    await expect(segmentFromText('x', { config: CFG, chat })).rejects.toThrow(/unknown field/)
  })

  it('an unknown operator is rejected the same way', async () => {
    const chat = chatReturning(JSON.stringify({
      entity: 'contact',
      include: [{ conditions: [{ kind: 'field', field: 'contact.status', op: 'smells_nice', value: 'x' }] }],
      exclude: [],
    }))
    await expect(segmentFromText('x', { config: CFG, chat })).rejects.toThrow(/unknown operator/)
  })

  it('blank text is rejected before any call to the model', async () => {
    const chat = chatReturning('{}')
    await expect(segmentFromText('   ', { config: CFG, chat })).rejects.toThrow(/plain English/)
    expect(chat).not.toHaveBeenCalled()
  })

  it('extractJson strips a fence and surrounding prose', () => {
    expect(extractJson('here you go:\n```json\n{"a":1}\n```\nhope that helps')).toEqual({ a: 1 })
  })
})
