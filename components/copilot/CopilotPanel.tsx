'use client'

/**
 * PLACEHOLDER. The copilot branch (feat/copilot) replaces this file with the
 * real assistant. The shell opens it in a right-side sheet (full screen on
 * phones) from the "Ask" button in the rail, top bar and bottom nav.
 */
export function CopilotPanel({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center" data-testid="copilot-panel-stub">
      <p className="text-sm font-semibold text-ink">Ask about your leads and campaigns</p>
      <p className="max-w-xs text-sm text-ink-muted">The assistant is coming soon. It will answer questions and suggest next steps right here.</p>
      {onClose ? (
        <button type="button" onClick={onClose} className="mt-2 text-xs font-medium text-accent hover:underline">
          Close
        </button>
      ) : null}
    </div>
  )
}

export default CopilotPanel
