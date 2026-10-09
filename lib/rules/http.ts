import { NextResponse } from 'next/server'
import { RulesError } from '@/lib/rules/schema'
import { OpsError } from '@/lib/ops/core'

export const NO_DB = 'The lead database is not connected (DATABASE_URL is not set).'

export function rulesFail(e: unknown) {
  if (e instanceof RulesError || e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}
