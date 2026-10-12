'use client'

/**
 * Goal picker for the New campaign form (plan 3.16): a fixed list of goals
 * plus a custom free-text option. Posts goal_key (+ goal_custom when
 * "Custom" is picked); the server resolves the stored goal.
 */
import { useState } from 'react'
import { INPUT, LABEL } from '@/components/campaigns/ui'
import { GOALS } from '@/lib/journeys/goals'

export function GoalPicker({ defaultGoalKey = '' }: { defaultGoalKey?: string }) {
  const [key, setKey] = useState(defaultGoalKey)
  return (
    <>
      <label className={LABEL}>Goal
        <select name="goal_key" className={INPUT} value={key} onChange={(e) => setKey(e.target.value)}>
          <option value="">Recipe default (or blank)</option>
          {GOALS.map((g) => (
            <option key={g.key} value={g.key} title={g.description}>{g.label}</option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {key === 'custom' ? (
        <label className={LABEL}>Custom goal
          <input name="goal_custom" maxLength={500} className={INPUT} placeholder="e.g. Reactivate last year's buyers" />
        </label>
      ) : null}
    </>
  )
}
