/**
 * WordPress through its own REST API (built in, free) with an Application
 * Password (Users > Profile > Application Passwords). Server-only; the
 * password never leaves the server. Every write is the owner's click after a
 * preview, stores the value before, and can be undone.
 *
 * Env: WP_SITE_URL (e.g. https://tapdash.co), WP_USER, WP_APP_PASSWORD.
 *
 * Elementor note (tapdash.co is Elementor + Hello theme): Elementor pages
 * ignore post content, so schema goes into a page meta field that a small
 * snippet prints in <head>; titles/descriptions go into Yoast's meta fields.
 * Both need the one-time snippet below (WP_SNIPPET) to be exposed to the API.
 */

export const YOAST_META = {
  title: '_yoast_wpseo_title',
  description: '_yoast_wpseo_metadesc',
  canonical: '_yoast_wpseo_canonical',
  noindex: '_yoast_wpseo_meta-robots-noindex',
} as const
export const JSONLD_META = '_tapdash_jsonld'
export const SNIPPET_KEYS = [...Object.values(YOAST_META), JSONLD_META]

export const WP_SNIPPET = `<?php
// TapDash dashboard: lets the dashboard set Yoast title / description /
// canonical / noindex and per-page JSON-LD through the WordPress REST API.
// Paste into the free "Code Snippets" plugin (Snippets > Add New), run everywhere.
add_action('init', function () {
  $keys = ['_yoast_wpseo_title', '_yoast_wpseo_metadesc', '_yoast_wpseo_canonical',
           '_yoast_wpseo_meta-robots-noindex', '_tapdash_jsonld'];
  foreach (['page', 'post'] as $type) {
    foreach ($keys as $k) {
      register_post_meta($type, $k, [
        'show_in_rest' => true, 'single' => true, 'type' => 'string',
        'auth_callback' => function () { return current_user_can('edit_pages'); },
      ]);
    }
  }
});
add_action('wp_head', function () {
  if (!is_singular()) return;
  $json = get_post_meta(get_the_ID(), '_tapdash_jsonld', true);
  if (!$json) return;
  $decoded = json_decode($json);
  if ($decoded === null) return;
  echo "\\n<script type=\\"application/ld+json\\">" . wp_json_encode($decoded) . "</script>\\n";
});
`

export interface WpConfig {
  siteUrl: string
  user: string
  appPassword: string
}

export function wpConfigFromEnv(env: Record<string, string | undefined> = process.env): WpConfig | null {
  const siteUrl = env.WP_SITE_URL?.trim()
  const user = env.WP_USER?.trim()
  const appPassword = env.WP_APP_PASSWORD?.trim()
  if (!siteUrl || !user || !appPassword) return null
  return { siteUrl: siteUrl.replace(/\/+$/, ''), user, appPassword }
}

/** Does this WordPress config belong to the tracked site? (same host, www-insensitive) */
export function wpMatchesSite(cfg: WpConfig | null, baseUrl: string): boolean {
  if (!cfg) return false
  try {
    const a = new URL(cfg.siteUrl).host.toLowerCase().replace(/^www\./, '')
    const b = new URL(baseUrl).host.toLowerCase().replace(/^www\./, '')
    return a === b
  } catch {
    return false
  }
}

export interface WpPage {
  id: number
  type: 'page' | 'post'
  link: string
  slug: string
  status: string
  title: string
  meta: Record<string, unknown> | null
}

export type WpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number
  text(): Promise<string>
}>

export class WpError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message)
  }
}

interface RawPost {
  id: number
  type?: string
  link: string
  slug: string
  status: string
  title?: { raw?: string; rendered?: string }
  meta?: Record<string, unknown> | unknown[]
}

export class WpClient {
  private fetcher: WpFetch
  constructor(private cfg: WpConfig, fetcher?: WpFetch) {
    this.fetcher = fetcher ?? (globalThis.fetch as unknown as WpFetch)
  }

  private auth() {
    return `Basic ${Buffer.from(`${this.cfg.user}:${this.cfg.appPassword.replace(/\s+/g, '')}`).toString('base64')}`
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.siteUrl}/wp-json${path}`
    const r = await this.fetcher(url, {
      method,
      headers: { Authorization: this.auth(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    const text = await r.text()
    if (/sgcaptcha/.test(text.slice(0, 2000))) {
      throw new WpError('SiteGround\'s anti-bot wall answered instead of WordPress. Ask SiteGround to allow the dashboard\'s server (or the WordPress REST API) through the bot challenge.', r.status)
    }
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      throw new WpError(`WordPress answered HTTP ${r.status} with something that isn't JSON.`, r.status)
    }
    if (r.status < 200 || r.status >= 300) {
      const msg = (json as { message?: string } | null)?.message
      throw new WpError(`WordPress answered HTTP ${r.status}${msg ? `: ${msg}` : ''}.`, r.status)
    }
    return json as T
  }

  private toPage(p: RawPost): WpPage {
    const meta = p.meta && !Array.isArray(p.meta) ? (p.meta as Record<string, unknown>) : null
    return {
      id: p.id,
      type: p.type === 'post' ? 'post' : 'page',
      link: p.link,
      slug: p.slug,
      status: p.status,
      title: p.title?.raw ?? p.title?.rendered ?? '',
      meta,
    }
  }

  /** Who the password belongs to; proves the credentials work. */
  async whoami(): Promise<{ id: number; name: string }> {
    return this.call('GET', '/wp/v2/users/me?context=edit')
  }

  /** Find a page (or post) by its public path, e.g. /jewelers/compare/clover/. */
  async findByPath(path: string): Promise<WpPage | null> {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) {
      // The front page: WordPress exposes its id in settings.
      const s = await this.call<{ page_on_front?: number }>('GET', '/wp/v2/settings')
      return s.page_on_front ? this.getPage(s.page_on_front, 'page') : null
    }
    const slug = parts[parts.length - 1]
    for (const type of ['pages', 'posts'] as const) {
      const list = await this.call<RawPost[]>('GET', `/wp/v2/${type}?slug=${encodeURIComponent(slug)}&context=edit&status=publish,draft,private,pending`)
      const want = `/${parts.join('/')}/`
      const hit = list.find((p) => {
        try {
          return new URL(p.link).pathname === want
        } catch {
          return false
        }
      })
      if (hit) return this.toPage({ ...hit, type: type === 'pages' ? 'page' : 'post' })
    }
    return null
  }

  /** Creation must not silently get WordPress's auto-suffixed duplicate slug. */
  async hasSlug(slug: string): Promise<boolean> {
    const list = await this.call<RawPost[]>('GET', `/wp/v2/pages?slug=${encodeURIComponent(slug)}&context=edit&status=publish,draft,private,pending,trash`)
    return list.some((p) => p.slug === slug)
  }

  async getPage(id: number, type: 'page' | 'post' = 'page'): Promise<WpPage> {
    const p = await this.call<RawPost>('GET', `/wp/v2/${type}s/${id}?context=edit`)
    return this.toPage({ ...p, type })
  }

  async update(id: number, type: 'page' | 'post', fields: { status?: string; title?: string; meta?: Record<string, string> }): Promise<WpPage> {
    const p = await this.call<RawPost>('POST', `/wp/v2/${type}s/${id}`, fields)
    return this.toPage({ ...p, type })
  }

  async createDraft(fields: { title: string; content: string; slug?: string; parent?: number }): Promise<WpPage> {
    const p = await this.call<RawPost>('POST', '/wp/v2/pages', { ...fields, status: 'draft' })
    return this.toPage({ ...p, type: 'page' })
  }

  async trashDraft(id: number): Promise<void> {
    await this.call('DELETE', `/wp/v2/pages/${id}`)
  }
}

/** Are the snippet's meta keys exposed on this page? (they appear in `meta` only once registered) */
export function snippetInstalled(page: WpPage): boolean {
  return !!page.meta && SNIPPET_KEYS.every((k) => k in (page.meta as Record<string, unknown>))
}
