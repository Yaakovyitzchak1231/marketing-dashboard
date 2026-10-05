## 2024-05-30 - Contextual ARIA labels on repeated action buttons
**Learning:** Generic text like "Delete" or "Edit" on buttons repeated in lists or tables is ambiguous for screen reader users who navigate interactively by components.
**Action:** Always provide contextual `aria-label`s on repeated generic action buttons (e.g., `aria-label="Delete idea: Jewelry outreach"`) so users know exactly which item they are acting on without needing to infer context from adjacent table cells or text blocks.

## 2024-10-02 - Explicit focus outlines for interactive elements
**Learning:** Default browser focus outlines can sometimes be overridden, indistinguishable from other borders, or simply look unpolished, leading to a poor experience for keyboard users trying to navigate the app.
**Action:** When creating or modifying custom interactive elements (like toggle buttons or sort buttons) that might lack clear default browser outlines, explicitly add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted` (or similar appropriate styles from the design tokens) to ensure keyboard navigation is distinct and visually clear without impacting mouse users.

## 2024-10-05 - Accessibility for form inputs and dynamic error messages
**Learning:** When using Tailwind's `outline-none` on form inputs and selects to remove default browser outlines, it severely harms keyboard navigation accessibility because users cannot see which element is currently focused. Furthermore, dynamic error messages that appear asynchronously without page reloads are not automatically announced by screen readers unless explicitly marked.
**Action:** Always pair `outline-none` on inputs/selects with `focus-visible:ring-2 focus-visible:ring-ink-muted` (or equivalent tokens) to restore accessible focus indicators. Always add `role="alert"` to containers displaying dynamic error or warning messages so assistive technologies announce them immediately when they render.
