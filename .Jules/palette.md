## 2024-05-30 - Contextual ARIA labels on repeated action buttons
**Learning:** Generic text like "Delete" or "Edit" on buttons repeated in lists or tables is ambiguous for screen reader users who navigate interactively by components.
**Action:** Always provide contextual `aria-label`s on repeated generic action buttons (e.g., `aria-label="Delete idea: Jewelry outreach"`) so users know exactly which item they are acting on without needing to infer context from adjacent table cells or text blocks.
