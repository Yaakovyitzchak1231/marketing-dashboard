/**
 * What each screen needs from Vercel's environment variables, in plain steps.
 *
 * Only whether a key is set ever leaves this module, never its value: the setup
 * screens render `set: boolean` and nothing else.
 */

export type SetupFeature = 'leads' | 'dashboard' | 'agents' | 'login'

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

/**
 * The Vercel team slug and project name, read from Vercel's system variables.
 * A deployment URL is "<project>-<9-char id>-<team>.vercel.app"; the project name is
 * VERCEL_PROJECT_NAME when set, else the Git repo name (Vercel names projects after it).
 */
export function vercelProject(env: Env = process.env): { team: string; project: string } | null {
  const host = (env.VERCEL_URL ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  const m = /^(.+)\.vercel\.app$/.exec(host)
  if (!m) return null
  const candidates = [env.VERCEL_PROJECT_NAME, env.VERCEL_GIT_REPO_SLUG]
    .map((s) => (s ?? '').trim().toLowerCase())
    .filter(Boolean)
  for (const project of candidates) {
    const rest = m[1].startsWith(`${project}-`) ? m[1].slice(project.length + 1) : null
    const t = rest ? /^[a-z0-9]{9}-([a-z0-9][a-z0-9-]*)$/.exec(rest) : null
    if (t) return { team: t[1], project }
  }
  return null
}

const SAFE = /^[a-z0-9][a-z0-9-]*$/

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
