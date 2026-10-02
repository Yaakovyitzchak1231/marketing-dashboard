## 2024-05-30 - Contextual ARIA labels on repeated action buttons
**Learning:** Generic text like "Delete" or "Edit" on buttons repeated in lists or tables is ambiguous for screen reader users who navigate interactively by components.
**Action:** Always provide contextual `aria-label`s on repeated generic action buttons (e.g., `aria-label="Delete idea: Jewelry outreach"`) so users know exactly which item they are acting on without needing to infer context from adjacent table cells or text blocks.

## 2024-10-02 - Explicit focus outlines for interactive elements
**Learning:** Default browser focus outlines can sometimes be overridden, indistinguishable from other borders, or simply look unpolished, leading to a poor experience for keyboard users trying to navigate the app.
**Action:** When creating or modifying custom interactive elements (like toggle buttons or sort buttons) that might lack clear default browser outlines, explicitly add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted` (or similar appropriate styles from the design tokens) to ensure keyboard navigation is distinct and visually clear without impacting mouse users.
