/**
 * The old top bar was replaced by the app shell (components/shell/AppShell).
 * These re-exports keep older imports working: the navigation's single
 * source of truth is components/shell/nav-config.ts.
 */
export { NAV_ITEMS, NAV_GROUPS, isActive, activeHref } from '@/components/shell/nav-config'
