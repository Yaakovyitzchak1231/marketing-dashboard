# Tools-hub runner handlers

Five job handlers for `runner/handlers/` (one job per kind, claimed and run by
the background runner on Yaakov's OVH server — see `docs/RUNNER.md` for how
the runner itself deploys). Each polls one tool's own API and writes what it
read through the ops API (`put_integration_snapshots` / `report_integration_health`),
never straight to Postgres. Missing data is always written as `null`, never `0`.

| job kind | tool | what it reads |
|---|---|---|
| `integration_health` | every tool with an API (skips docs/sheets) | the tool's root/health endpoint; writes `ok`/`degraded`/`down` |
| `integration_listmonk` | Listmonk | `/api/lists` → subscribers per list |
| `integration_miniflux` | Miniflux | `/v1/categories` + `/v1/categories/{id}/entries?status=unread&limit=1` → unread per category |
| `integration_changedetection` | changedetection.io | `/api/v1/watch` → changes in the last 24h, grouped by tag |
| `integration_umami` | Umami | `/api/websites/{id}/stats` and `/metrics?type=campaign` → visits and UTM campaign breakdown, last 24h |

Each of `integration_listmonk` / `_miniflux` / `_changedetection` runs with no
config beyond its own env vars and `payload: { integration_id? }` (defaults to
the tool's own id, e.g. `"listmonk"`); `integration_umami` additionally needs
`UMAMI_WEBSITE_ID`. `integration_health` takes `payload: { ids?: string[] }` to
limit which tools it checks (default: every active, non-doc tool).

## Tool API keys (the runner's own env file)

The settings store (item 1.1) holds non-secret config under `integrations.<id>.*`
and never returns a secret over the ops API, so each tool's own API key lives
**only** in the runner's env file (`~/.config/tapdash-runner.env` on OVH, chmod
600 — see `docs/RUNNER.md`), never in the database and never logged. These are
the env vars the handlers above read:

```
# Listmonk (Settings -> Users, or an API user) -- Basic auth
LISTMONK_API_URL=         # optional; defaults to the "listmonk" integration's api_url
LISTMONK_API_USER=api     # optional, default "api"
LISTMONK_API_KEY=

# Miniflux (Settings -> API Keys) -- X-Auth-Token header
MINIFLUX_API_URL=         # optional; defaults to the "miniflux" integration's api_url
MINIFLUX_API_KEY=

# changedetection.io (Settings -> API) -- x-api-key header
CHANGEDETECTION_API_URL=  # optional; defaults to the "changedetection" integration's api_url
CHANGEDETECTION_API_KEY=

# Umami (Settings -> API keys) -- x-umami-api-key header
UMAMI_API_URL=            # optional; defaults to the "umami" integration's api_url
UMAMI_API_KEY=
UMAMI_WEBSITE_ID=         # the website to read stats for (none exists until a site is set up in Umami)
```

Every var above is optional at the handler level: a handler with its key
missing logs one line ("... not set in the runner env -- nothing read"),
returns `{ ok: false, reason: 'not configured' }`, and writes nothing --
it never throws, so one unconfigured tool doesn't fail the whole poll loop
when several handlers run as separate `lp.jobs` rows.

## Mapping a tool's own grouping to a dashboard campaign

- Listmonk list / Umami UTM campaign value → matched against
  `lp.campaign_profiles.newsletter_list` / `.utm->>'campaign'` (ops
  `campaign_for_newsletter_list` / `campaign_for_utm_campaign`, added in
  `lib/integrations/ops.ts` as plain reads against that table -- no import of
  the campaign-profiles module itself, to avoid a merge conflict with it).
- Miniflux category title / changedetection tag → matched against
  `lp.campaigns.name` (the existing `list_campaigns` op), case-insensitively.
- No match (or the lookup itself fails): the snapshot is still written, with
  `campaign_id: null` and the raw list/category/tag name in `dims`, so nothing
  is silently dropped and the /tools page still shows the number.

## Scheduling

Each handler is meant to run as its own `lp.jobs` row (`kind` = one of the
five above, `schedule_cron` e.g. every 15-30 minutes), added once the runner
is deployed and these keys exist in its env file. Nothing here runs on its own
until a job row points at it and the runner is enabled -- see `docs/RUNNER.md`,
"Not deployed -- waiting for Yaakov's OK".
