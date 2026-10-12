// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import React from 'react'
import { ApprovalDecideForm } from '@/components/ops/ApprovalDecideForm'

afterEach(cleanup)
const action = async () => {}
const valueChange = { kind: 'instantly_value_change', entity_id: 1, field: 'opens', current: 1, proposed: 0 }
const other = { note: 'spend $20 on lookups' }

describe('Activity approvals: Ask to change is owner-only in the UI', () => {
  it('an editor sees no Approve/Reject for a value-change request, just a note', () => {
    render(<ApprovalDecideForm approvalId={1} payload={valueChange} role="editor" action={action} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
    expect(screen.getByText('Waiting for an owner to decide.')).toBeTruthy()
  })
  it('an editor still sees Approve/Reject for other kinds', () => {
    render(<ApprovalDecideForm approvalId={2} payload={other} role="editor" action={action} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
  })
  it('an owner sees Approve/Reject for a value-change request', () => {
    render(<ApprovalDecideForm approvalId={3} payload={valueChange} role="owner" action={action} />)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(screen.queryByText('Waiting for an owner to decide.')).toBeNull()
  })
})
