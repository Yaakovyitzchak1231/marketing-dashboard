/**
 * What each screen needs from Vercel's environment variables, in plain steps.
 *
 * Only whether a key is set ever leaves this module, never its value: the setup
 * screens render `set: boolean` and nothing else.
 */

export type SetupFeature = 'leads' | 'dashboard' | 'agents' | 'notifications' | 'login'

export interface EnvKeySpec {
  key: string
  required: boolean
  /** What it does, one line. */
  purpose: string
  /** Click-by-click, for someone in the Vercel dashboard. */
  steps: string[]
  /** Set automatically by an integration, so there is nothing to paste. */
  automatic?: boolean
}

export interface EnvKeyStatus extends EnvKeySpec {
  set: boolean
}

const REDEPLOY = 'Redeploy: Deployments tab → the ⋯ menu on the newest deployment → Redeploy.'

export const FEATURE_TITLES: Record<SetupFeature, string> = {
  leads: 'Lead database',
  dashboard: 'Instantly campaigns',
  agents: 'Agent access (ops API)',
  notifications: 'Agent notifications',
  login: 'Login',
}

export const ENV_SPECS: Record<SetupFeature, EnvKeySpec[]> = {
  leads: [
    {
      key: 'DATABASE_URL',
      required: true,
      automatic: true,
      purpose: 'The Postgres database every lead screen reads from. Nothing to type: Vercel creates it.',
      steps: [
        'In Vercel, open this project and click the Storage tab.',
        'Click Create Database, pick Neon (free Postgres), then Continue.',
        'On the Connect screen, set Custom Prefix to DATABASE (so the key is named DATABASE_URL). Keep Production and Preview ticked.',
        'Click Connect. Vercel adds DATABASE_URL to this project by itself.',
        `${REDEPLOY} The tables are created during that deploy.`,
      ],
    },
  ],
  agents: [
    {
      key: 'OPS_AGENT_TOKENS',
      required: false,
      purpose: 'Lets agents (Tab, Hermes, Claude) use the ops API and load the Lead Master, each with its own token.',
      steps: [
        'In Vercel, open this project → Settings → Environment Variables.',
        'Add the key OPS_AGENT_TOKENS with the value your agent gives you (it looks like tab:… ). Tick Production, and mark it Sensitive.',
        REDEPLOY,
      ],
    },
  ],
  notifications: [
    {
      key: 'MAIL_PROVIDER', required: false,
      purpose: 'Required for email delivery, including Tab’s mailbox. Use resend or brevo. Without mail settings, emails stay held; feed access still works.',
      steps: ['Choose Resend or Brevo and verify a sender there. Set MAIL_PROVIDER to resend or brevo in Vercel.', REDEPLOY],
    },
    {
      key: 'MAIL_API_KEY', required: false,
      purpose: 'Required for email delivery. The chosen mail provider’s API key, server-side only.',
      steps: ['Add the provider key in Vercel as Sensitive. Never paste it in comments or agent messages.', REDEPLOY],
    },
    {
      key: 'MAIL_FROM', required: false,
      purpose: 'Required for email delivery. A sender address verified by the mail provider.',
      steps: ['Set MAIL_FROM to the verified sender address in Vercel.', REDEPLOY],
    },
    {
      key: 'CRON_SECRET', required: false,
      purpose: 'Protects the delivery retry endpoint. Setting it does not create a schedule: connect a scheduler to /api/ops/deliveries/dispatch so retries continue when nobody has the app open.',
      steps: ['Store a random secret of at least 32 characters in Vercel as Sensitive and in your scheduler’s credential store.', 'Configure the scheduler to GET /api/ops/deliveries/dispatch with bearer authentication. Never place the secret in the URL.', REDEPLOY],
    },
  ],
  dashboard: [
    {
      key: 'INSTANTLY_API_KEY',
      required: true,
      purpose: 'Reads your campaigns live from Instantly.',
      steps: [
        'In Instantly, go to Settings → Integrations → API Keys and create a key. Read-only (all:read) is enough.',
        'In Vercel, open this project → Settings → Environment Variables, add INSTANTLY_API_KEY with that key, tick Production, mark it Sensitive.',
        REDEPLOY,
      ],
    },
    {
      key: 'DASHBOARD_TZ',
      required: false,
      purpose: 'Which timezone a "day" is in (default America/New_York).',
      steps: ['Add DASHBOARD_TZ in Settings → Environment Variables, for example America/New_York.', REDEPLOY],
    },
  ],
  login: [
    {
      key: 'ALLOWED_USER_EMAIL',
      required: true,
      purpose: 'The one email address allowed to sign in.',
      steps: ['Add ALLOWED_USER_EMAIL in Settings → Environment Variables with your email.', REDEPLOY],
    },
    {
      key: 'NEXT_PUBLIC_SUPABASE_URL',
      required: true,
      purpose: 'Sign-in service address (Supabase → Project Settings → API).',
      steps: ['Copy the Project URL from Supabase → Project Settings → API into NEXT_PUBLIC_SUPABASE_URL.', REDEPLOY],
    },
    {
      key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      required: true,
      purpose: 'Sign-in service public key (Supabase → Project Settings → API).',
      steps: ['Copy the anon public key from Supabase → Project Settings → API into NEXT_PUBLIC_SUPABASE_ANON_KEY.', REDEPLOY],
    },
  ],
}

type Env = Record<string, string | undefined>

function isSet(env: Env, key: string): boolean {
  if (key === 'DATABASE_URL') return Boolean((env.DATABASE_URL ?? '').trim())
  return Boolean((env[key] ?? '').trim())
}

/** Every key a feature reads, with whether it is set. Values are never returned. */
export function envStatus(feature: SetupFeature, env: Env = process.env): EnvKeyStatus[] {
  return ENV_SPECS[feature].map((spec) => ({ ...spec, steps: [...spec.steps], set: isSet(env, spec.key) }))
}

const DASHBOARD = 'https://vercel.com/dashboard'

const SAFE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Assumptions and limits of Vercel URL parsing.
 *
 * Vercel's system variables do not expose the team slug, so the team can only be
 * inferred from a deployment hostname. This module therefore does its best and
 * falls back to the dashboard — it never invents a team or project name.
 *
 * What we can actually read:
 * - Legacy preview hostnames look like `<project>-<9 char id>-<team>.vercel.app`.
 *   The 9-char id is what makes the split between project name and team
 *   unambiguous, so we require it. That also makes project names with dashes
 *   safe: `my-project-ab12cd34e-acme` parses as project `my-project`, team `acme`.
 * - Production hostnames are `<project>.vercel.app` (no team segment) or a custom
 *   domain. Neither yields a team, so we cannot build the exact project URL for
 *   them and fall back to the dashboard rather than link to the wrong project.
 * - Custom domains never end in `.vercel.app`, so nothing can be derived from
 *   them and we fall back to the dashboard.
 *
 * Project name candidates, in order: VERCEL_PROJECT_NAME (when the operator has set
 * it — it is NOT a Vercel system variable), then VERCEL_GIT_REPO_SLUG (the Git repo
 * slug, which Vercel uses to name a project only when it has never been renamed).
 *
 * If Vercel changes this format, the worst case is a fallback to the dashboard —
 * never a link to the wrong project.
 */
export function vercelProject(env: Env = process.env): { team: string; project: string } | null {
  const app = stripVercelApp(hostname(env.VERCEL_URL))
  if (!app) return null // not a *.vercel.app host (custom domain, localhost, …)

  for (const project of projectCandidates(env)) {
    const team = teamFromLegacyPreview(app, project)
    if (team) return { team, project }
  }
  return null
}

/** Read a hostname from a URL-like string: lowercased, scheme and path stripped. */
function hostname(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

/** The subdomain part of a `*.vercel.app` host, or null for any other host. */
function stripVercelApp(host: string): string | null {
  return host.endsWith('.vercel.app') ? host.slice(0, -'.vercel.app'.length) : null
}

/** Project name candidates, most authoritative first. */
function projectCandidates(env: Env): string[] {
  return [env.VERCEL_PROJECT_NAME, env.VERCEL_GIT_REPO_SLUG]
    .map((s) => (s ?? '').trim().toLowerCase())
    .filter(Boolean)
}

/**
 * The legacy preview shape is `<project>-<9 char id>-<team>`. The 9-char id is what
 * keeps a dashed project name from bleeding into the team, so we require it: a
 * candidate that merely prefixes the real name leaves a remainder too short to
 * match, and we fall back instead of guessing where the project name ends.
 */
function teamFromLegacyPreview(app: string, project: string): string | null {
  const prefix = `${project}-`
  if (!app.startsWith(prefix)) return null
  const rest = app.slice(prefix.length)
  const m = /^([a-z0-9]{9})-([a-z0-9][a-z0-9-]*)$/.exec(rest)
  return m ? m[2] : null
}

/** Link straight to this project's Environment Variables page, or the closest thing. */
export function vercelEnvSettingsUrl(env: Env = process.env): { url: string; exact: boolean } {
  const p = vercelProject(env)
  if (p && SAFE.test(p.team) && SAFE.test(p.project)) {
    return { url: `https://vercel.com/${p.team}/${p.project}/settings/environment-variables`, exact: true }
  }
  return { url: DASHBOARD, exact: false }
}

/** Link to this project's page in Vercel (its tabs include Storage and Deployments), or the dashboard. */
export function vercelProjectUrl(env: Env = process.env): string {
  const p = vercelProject(env)
  return p && SAFE.test(p.team) && SAFE.test(p.project) ? `https://vercel.com/${p.team}/${p.project}` : DASHBOARD
}
