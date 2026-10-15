## 2024-10-15 - [Improve Button Interaction States]
**Learning:** Found raw `<button>` elements that were missing standard focus, hover and disabled visual cues when outside the scope of the global `<Button />` component, relying just on bare `border-line` and standard styles.
**Action:** When adding inline/custom buttons that deviate from `<Button />`, always append `outline-none transition-colors hover:border-ink-faint hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ink-muted disabled:cursor-not-allowed disabled:opacity-50` for standard accessibility support.
