-- Phase 1 foundation, part 7 (Oct 11, 2026): seed the tools hub.
--
-- lp.integrations rows for the tools Yaakov runs next to the dashboard, so the
-- /tools page and the OVH runner's health/snapshot handlers have something to
-- read -- data he can edit (app/tools), never a URL hard-coded in app code.
--
-- "url" is what a person opens; "api_url" is the 127.0.0.1:<port> address the
-- OVH runner calls locally (it runs on the same box as these tools). Warmbly
-- is reachable publicly through its Tailscale Funnel; the rest are tailnet-only
-- (bound to 100.104.103.48 and 127.0.0.1 only, per ovh_marketing_tools_oct11.md).
-- Postiz was not installed (skipped for disk/RAM) and has no row here.

insert into lp.integrations
  (id, name, kind, description, url, api_url, reachable_from, settings_prefix, visibility, sort, active)
values
  ('warmbly', 'Warmbly', 'warmbly',
   'Yaakov''s agent platform (Hermes runs here too).',
   'https://ovh-hermes.taila95862.ts.net', 'http://127.0.0.1:18500',
   'public', 'integrations.warmbly', 'owner', 10, true),

  ('listmonk', 'Listmonk', 'listmonk',
   'Newsletters to opted-in leads.',
   'http://100.104.103.48:18510/admin', 'http://127.0.0.1:18510',
   'tailnet', 'integrations.listmonk', 'owner', 20, true),

  ('miniflux', 'Miniflux', 'miniflux',
   'RSS / news aggregator with a REST API.',
   'http://100.104.103.48:18520', 'http://127.0.0.1:18520',
   'tailnet', 'integrations.miniflux', 'owner', 30, true),

  ('changedetection', 'changedetection.io', 'changedetection',
   'Page-change watcher for signals and competitors.',
   'http://100.104.103.48:18530', 'http://127.0.0.1:18530',
   'tailnet', 'integrations.changedetection', 'owner', 40, true),

  ('umami', 'Umami', 'umami',
   'Web analytics and UTM campaign breakdowns.',
   'http://100.104.103.48:18540', 'http://127.0.0.1:18540',
   'tailnet', 'integrations.umami', 'owner', 50, true),

  ('build_tracker', 'Build tracker', 'sheet',
   'The Google Sheet tracking every dashboard feature''s status and PR.',
   'https://docs.google.com/spreadsheets/d/1VziDdxMCfpSBWD3oc8WR9Y7Dq0N9XBibDhtzB7tiyJU/edit', null,
   'public', null, 'owner', 60, true),

  ('build_plan', 'Build plan', 'doc',
   'The Google Doc with the full dashboard build plan.',
   'https://docs.google.com/document/d/15gcEcu01Zrmn8PH7zZfzATmJw1x3QxTWXZTxyfBUHS0/edit', null,
   'public', null, 'owner', 70, true)
on conflict (id) do nothing;
