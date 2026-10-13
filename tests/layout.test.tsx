import { describe, it, expect, vi } from 'vitest'

// The layout mounts the comment layer, whose server actions import server-only modules.
vi.mock('server-only', () => ({}))
import RootLayout, { metadata, viewport } from '../app/layout'
import { AppShell } from '@/components/shell/AppShell'
import { THEME_BOOT_SCRIPT } from '@/components/shell/preferences'
import { PageComments } from '@/components/comments/PageComments'
import { ViewOnlyGuard } from '@/components/auth/ViewOnlyGuard'

describe('RootLayout', () => {
  it('exports correct metadata', () => {
    expect(metadata.title).toEqual({ default: 'TapDash', template: '%s · TapDash' })
    expect(metadata.description).toBe('Leads, verification, campaigns and replies in one place.')
    // The phone bottom bar sits above the home indicator.
    expect(viewport.viewportFit).toBe('cover')
  })

  it('boots the theme before paint, then renders the app shell around the page and the comment layer', () => {
    // Calling the component as a function allows us to inspect the element tree directly
    // This avoids jsdom stripping html/body tags when wrapped in render's default container
    const element = RootLayout({ children: { type: 'div', props: { 'data-testid': 'child', children: 'Hello World' } } as any })

    expect(element.type).toBe('html')
    expect(element.props.lang).toBe('en')

    const [head, body] = element.props.children
    expect(head.type).toBe('head')
    expect(head.props.children.props.dangerouslySetInnerHTML.__html).toBe(THEME_BOOT_SCRIPT)
    expect(body.type).toBe('body')

    const [shell, guard] = body.props.children
    expect(shell.type).toBe(AppShell)
    expect(guard.type).toBe(ViewOnlyGuard)

    const [child, comments] = shell.props.children
    expect(child.props['data-testid']).toBe('child')
    expect(child.props.children).toBe('Hello World')
    expect(comments.type).toBe(PageComments)
  })
})
