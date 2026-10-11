/** GET /api/leads/fields -> {fields: FieldDef[]} -- the advanced-filters drawer's Standard tab field picker (lib/segments/fields.ts's registry). */
import { NextResponse } from 'next/server'
import { allFields } from '@/lib/segments/fields'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ fields: allFields() })
}
