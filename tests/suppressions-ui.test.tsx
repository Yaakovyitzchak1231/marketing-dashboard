// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { TierPill } from '@/components/campaigns/ui'

describe('TierPill: suppressed leads read as Parked — suppressed (reason)', () => {
  it('a suppressed reason wins over the tier, even a Ready one', () => {
    render(<TierPill tier="ready_personalized" suppressedReason="unsubscribed" />)
    expect(screen.getByText('Parked — suppressed (unsubscribed)')).toBeInTheDocument()
  })

  it('no suppression: the ordinary tier pill', () => {
    render(<TierPill tier="parked" />)
    expect(screen.getByText('Parked')).toBeInTheDocument()
  })

  it('not scored yet, unaffected by suppression', () => {
    render(<TierPill tier={null} />)
    expect(screen.getByText('Not scored yet')).toBeInTheDocument()
  })
})
