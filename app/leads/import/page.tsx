import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { listPools } from '@/lib/pools/store'
import { listCampaigns } from '@/lib/campaigns/store'
import { listFieldDefs } from '@/lib/fields/registry'
import { ImportWizard } from '@/components/leads/ImportWizard'
import { parseCsvAction, previewImportAction, runImportAction } from '@/app/actions/leads-import'

export const dynamic = 'force-dynamic'

export default async function ImportPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Import leads">
        <DbNotConnected what="Import" />
      </PageShell>
    )
  }
  const [pools, campaigns, contactFields, companyFields] = await Promise.all([
    listPools(db),
    listCampaigns(db),
    listFieldDefs(db, { entity: 'contact' }),
    listFieldDefs(db, { entity: 'company' }),
  ])
  return (
    <PageShell title="Import leads" meta="Map your CSV's columns, see exactly what would happen, then import. Nothing is written until the last step.">
      <section>
        <SectionHeader title="CSV import" />
        <Card className="p-4">
          <ImportWizard
            parseCsv={parseCsvAction}
            preview={previewImportAction}
            runImport={runImportAction}
            pools={pools.map((p) => ({ id: p.id, label: p.label }))}
            campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
            contactCustomFields={contactFields.map((f) => ({ key: f.key, label: f.label }))}
            companyCustomFields={companyFields.map((f) => ({ key: f.key, label: f.label }))}
          />
        </Card>
      </section>
    </PageShell>
  )
}
