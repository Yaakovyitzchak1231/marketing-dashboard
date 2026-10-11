/**
 * Quiet-hours setting keys. Kept in a plain module (not the 'use client'
 * QuietHoursField) so the server-rendered Settings page reads real strings:
 * a constant exported from a client module reaches server code as a client
 * reference, not its value, and the page then fell back to two text rows.
 */
export const QUIET_START_KEY = 'workspace.quiet_hours_start'
export const QUIET_END_KEY = 'workspace.quiet_hours_end'
