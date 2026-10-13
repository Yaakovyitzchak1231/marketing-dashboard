import {
  Activity,
  Bot,
  CalendarClock,
  ChartColumn,
  Filter,
  Globe,
  Home,
  Inbox,
  ListChecks,
  MailCheck,
  Megaphone,
  Ban,
  Scale,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Other paths that belong to this destination (old URLs, sub-areas). */
  match?: string[]
  /** Never highlight this item for these paths (a longer match wins anyway). */
  keywords?: string
}

export interface NavGroup {
  id: string
  title: string | null
  /** Operations starts collapsed on desktop. */
  collapsible?: boolean
  items: NavItem[]
}

/**
 * The information architecture. Every old URL still works: it either is one
 * of these routes or lives under one (see `match`).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'work',
    title: null,
    items: [
      { href: '/', label: 'Home', icon: Home, keywords: 'overview dashboard' },
      { href: '/leads', label: 'Leads', icon: Users, match: ['/find'], keywords: 'find leads import duplicates companies contacts' },
      { href: '/campaigns', label: 'Campaigns', icon: Megaphone, match: ['/angles', '/ideas', '/costs', '/workspace'], keywords: 'instantly performance sequences steps' },
      { href: '/inbox', label: 'Inbox', icon: Inbox, match: ['/replies', '/agents/owner'], keywords: 'replies approvals needs your ok notifications' },
    ],
  },
  {
    id: 'organize',
    title: 'Organize',
    items: [
      { href: '/verify', label: 'Verification', icon: MailCheck, keywords: 'verify emails bounce check' },
      { href: '/segments', label: 'Segments', icon: Filter, keywords: 'audiences lists traits' },
      { href: '/suppressions', label: 'Suppressions', icon: Ban, keywords: 'do not contact unsubscribe block list' },
      { href: '/rules', label: 'Scoring & Rules', icon: Scale, keywords: 'lead rules scoring ready parked' },
    ],
  },
  {
    id: 'insights',
    title: 'Insights',
    items: [
      { href: '/reports', label: 'Reports', icon: ChartColumn, keywords: 'weekly runway cost per meeting export' },
      { href: '/seo', label: 'SEO', icon: Globe, keywords: 'ai visibility audit search console citations fixes' },
    ],
  },
  {
    id: 'ops',
    title: 'Operations',
    collapsible: true,
    items: [
      { href: '/team', label: 'Team & Tasks', icon: ListChecks, keywords: 'board tasks' },
      { href: '/agents', label: 'Agents', icon: Bot, keywords: 'tab hermes claude manus' },
      { href: '/activity', label: 'Activity log', icon: Activity, keywords: 'audit log history' },
      { href: '/jobs', label: 'Jobs', icon: CalendarClock, keywords: 'schedule background runner cron' },
      { href: '/tools', label: 'Runner & Tools', icon: Server, keywords: 'data sources health integrations' },
      { href: '/settings', label: 'Settings', icon: Settings, match: ['/setup'], keywords: 'api keys mail users fields tags pools' },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items)

function under(pathname: string, base: string): boolean {
  if (base === '/') return pathname === '/'
  return pathname === base || pathname.startsWith(`${base}/`)
}

/** True when `href` is the current destination (sub-pages included). */
export function isActive(pathname: string, href: string): boolean {
  return activeHref(pathname) === href
}

/** The one nav destination that owns `pathname`: the longest matching path wins. */
export function activeHref(pathname: string): string | null {
  let best: { href: string; len: number } | null = null
  for (const item of NAV_ITEMS) {
    for (const base of [item.href, ...(item.match ?? [])]) {
      if (under(pathname, base) && (!best || base.length > best.len)) best = { href: item.href, len: base.length }
    }
  }
  return best?.href ?? null
}

/** Bottom bar on phones: the four daily destinations. "More" opens the drawer. */
export const BOTTOM_NAV: string[] = ['/', '/leads', '/campaigns', '/inbox']

/** Extra destinations the command palette can jump to (sub-pages and actions). */
export const PALETTE_EXTRAS: { href: string; label: string; group: 'Actions' | 'Pages'; keywords?: string }[] = [
  { href: '/find', label: 'Find new leads', group: 'Actions', keywords: 'search engine scrape' },
  { href: '/leads/add', label: 'Add a lead', group: 'Actions', keywords: 'new company contact' },
  { href: '/leads/import', label: 'Import leads from CSV', group: 'Actions', keywords: 'upload spreadsheet' },
  { href: '/campaigns/new', label: 'New campaign', group: 'Actions', keywords: 'create' },
  { href: '/segments/new', label: 'New segment', group: 'Actions', keywords: 'audience create' },
  { href: '/verify', label: 'Verify emails', group: 'Actions' },
  { href: '/leads/duplicates', label: 'Find duplicate leads', group: 'Pages', keywords: 'merge' },
  { href: '/campaigns/performance', label: 'Campaign performance (Instantly)', group: 'Pages', keywords: 'analytics reply rate' },
  { href: '/reports/weekly', label: 'Weekly one-pager', group: 'Pages' },
  { href: '/reports/runway', label: 'Lead runway', group: 'Pages' },
  { href: '/reports/costs', label: 'Cost per meeting', group: 'Pages' },
  { href: '/seo/visibility', label: 'AI visibility', group: 'Pages', keywords: 'chatgpt gemini claude perplexity' },
  { href: '/seo/audit', label: 'SEO technical audit', group: 'Pages' },
  { href: '/seo/todos', label: 'SEO fix list', group: 'Pages' },
  { href: '/seo/sites', label: 'SEO sites', group: 'Pages' },
  { href: '/seo/citations', label: 'SEO citations & actions', group: 'Pages' },
  { href: '/seo/search-console', label: 'Search Console', group: 'Pages' },
  { href: '/segments/traits', label: 'Segment traits', group: 'Pages' },
  { href: '/settings/users', label: 'Users & roles', group: 'Pages' },
  { href: '/settings/fields', label: 'Custom fields', group: 'Pages' },
  { href: '/settings/tags', label: 'Tags', group: 'Pages' },
  { href: '/settings/pools', label: 'Pools', group: 'Pages' },
  { href: '/settings/scoring', label: 'Scoring models', group: 'Pages' },
  { href: '/settings/event-types', label: 'Event types', group: 'Pages' },
  { href: '/agents/owner', label: 'My profile, channels & quiet hours', group: 'Pages', keywords: 'me owner memory' },
  { href: '/angles', label: 'Angles', group: 'Pages', keywords: 'messaging' },
  { href: '/ideas', label: 'Ideas', group: 'Pages' },
  { href: '/costs', label: 'Cost table', group: 'Pages' },
  { href: '/workspace', label: 'Shared workspace', group: 'Pages', keywords: 'revisions approvals' },
]
