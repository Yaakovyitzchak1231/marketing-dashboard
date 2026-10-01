import { describe, it, expect } from 'vitest'
import RootLayout, { metadata } from '../app/layout'
import { render } from '@testing-library/react'
import React from 'react'

describe('RootLayout', () => {
  it('exports correct metadata', () => {
    expect(metadata.title).toBe('Marketing dashboard')
    expect(metadata.description).toBe('Campaign and sender-health metrics from Instantly.')
  })

  it('renders children within html and body tags', () => {
    // Calling the component as a function allows us to inspect the element tree directly
    // This avoids jsdom stripping html/body tags when wrapped in render's default container
    const element = RootLayout({ children: { type: 'div', props: { 'data-testid': 'child', children: 'Hello World' } } as any })

    expect(element.type).toBe('html')
    expect(element.props.lang).toBe('en')

    const body = element.props.children
    expect(body.type).toBe('body')

    const child = body.props.children
    expect(child.props['data-testid']).toBe('child')
    expect(child.props.children).toBe('Hello World')
  })
})
