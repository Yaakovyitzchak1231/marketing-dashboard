'use client'

import { useState } from 'react'
import { runRetentionSweepAction } from '@/app/actions/retention'

export function RunSweepButton() {
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle')
  const [result, setResult] = useState<string | null>(null)

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        disabled={state === 'running'}
        onClick={async () => {
          setState('running')
          setResult(null)
          const r = await runRetentionSweepAction()
          if (!r.ok) {
            setState('error')
            setResult(r.error)
            return
          }
          setState('idle')
          setResult(`Deleted ${r.total_deleted} event row${r.total_deleted === 1 ? '' : 's'} past their retention window`)
        }}
        className="rounded-card border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === 'running' ? 'Running…' : 'Run sweep now'}
      </button>
      {result ? <span className={`text-[12px] ${state === 'error' ? 'text-bad' : 'text-ink-faint'}`}>{result}</span> : null}
    </div>
  )
}
