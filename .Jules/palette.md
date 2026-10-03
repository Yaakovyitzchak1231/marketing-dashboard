## 2024-05-30 - Contextual ARIA labels on repeated action buttons
**Learning:** Generic text like "Delete" or "Edit" on buttons repeated in lists or tables is ambiguous for screen reader users who navigate interactively by components.
**Action:** Always provide contextual `aria-label`s on repeated generic action buttons (e.g., `aria-label="Delete idea: Jewelry outreach"`) so users know exactly which item they are acting on without needing to infer context from adjacent table cells or text blocks.

## 2024-10-02 - Explicit focus outlines for interactive elements
**Learning:** Default browser focus outlines can sometimes be overridden, indistinguishable from other borders, or simply look unpolished, leading to a poor experience for keyboard users trying to navigate the app.
**Action:** When creating or modifying custom interactive elements (like toggle buttons or sort buttons) that might lack clear default browser outlines, explicitly add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted` (or similar appropriate styles from the design tokens) to ensure keyboard navigation is distinct and visually clear without impacting mouse users.
## 2024-10-24 - Explicit focus states on input fields with outline-none
**Learning:** Adding `outline-none` in Tailwind removes the browser's default focus ring, which severely impacts keyboard navigation visibility unless an alternative visual indicator is explicitly provided via `focus-visible:ring-*`.
**Action:** Always add explicit `focus-visible` ring classes to any interactive elements (like inputs and selects) where `outline-none` is applied.

## 2024-10-24 - ARIA roles for dynamically rendered error messages
**Learning:** When form error messages are rendered conditionally (e.g., `{error && <div>{error}</div>}`), screen readers may not automatically announce their appearance, leaving assistive technology users unaware of submission failures.
**Action:** Add `role="alert"` to containers that render dynamic error messages to ensure immediate announcement upon rendering.
