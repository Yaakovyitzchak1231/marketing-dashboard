import { Sparkles } from 'lucide-react'

/**
 * PLACEHOLDER. The copilot branch (feat/copilot) replaces this file with the
 * real "Suggested for you" feed at the top of Home.
 */
export function SuggestionsFeed() {
  return (
    <section aria-labelledby="suggested-h" data-testid="suggestions-feed-stub" className="rounded-card border border-dashed border-line bg-surface/60 px-4 py-3">
      <h2 id="suggested-h" className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Sparkles aria-hidden="true" className="h-4 w-4 text-accent" />
        Suggested for you
      </h2>
      <p className="mt-0.5 text-xs text-ink-muted">Personal suggestions for what to do next will show up here.</p>
    </section>
  )
}

export default SuggestionsFeed
