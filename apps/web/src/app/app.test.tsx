import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NAV_ITEMS } from '@/app/shell/nav'
import { fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const ME = { employer: { id: 'e1', name: 'Acme Traders', email: 'owner@acme.test' } }
const healthy = () => ({
  'GET /healthz': () => json({ status: 'ok' }),
  'GET /api/v1/me': () => json(ME),
})

beforeEach(() => {
  fake.reset()
  fake.setSession('owner@acme.test')
})

describe('App shell (signed in)', () => {
  it('has exactly the four approved primary navigation items', () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual([
      'Dashboard',
      'Collections',
      'Upload',
      'Settings',
    ])
  })

  it('renders landmarks, skip link, primary nav, workspace name and account menu', async () => {
    mockApi(healthy())
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Skip to content' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    for (const item of NAV_ITEMS) {
      expect(nav).toContainElement(screen.getByRole('link', { name: item.label }))
    }
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByTitle('Workspace')).toHaveTextContent('Acme Traders')
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument()
  })

  it('marks the active section', async () => {
    mockApi(healthy())
    renderApp('/collections')
    expect(await screen.findByRole('link', { name: 'Collections' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('shows a not-found page inside the shell for unknown routes', async () => {
    mockApi(healthy())
    renderApp('/nope')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })
})

describe('Connectivity diagnostics', () => {
  it('reports the backend as reachable when /healthz answers', async () => {
    mockApi(healthy())
    renderApp('/')
    expect(await screen.findByText(/API reachable \(ok\)/)).toBeInTheDocument()
    expect(await screen.findByText('Signed in')).toBeInTheDocument()
  })

  it('shows a clear error when the backend is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    )
    renderApp('/')
    expect(await screen.findByText('API unreachable')).toBeInTheDocument()
  })
})

describe('Public payment route', () => {
  it('renders standalone (no employer navigation, no auth needed) and makes no API call', async () => {
    fake.setSession(null)
    const api = mockApi({})
    renderApp('/pay/some-token')
    expect(await screen.findByRole('heading', { name: 'Payment page' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
    await waitFor(() => expect(api.fn).not.toHaveBeenCalled())
    expect(document.body.textContent).not.toContain('some-token')
  })
})
