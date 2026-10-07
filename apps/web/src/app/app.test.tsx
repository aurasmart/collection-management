import { screen } from '@testing-library/react'
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
  'GET /api/v1/me': () => json(ME),
  'GET /api/v1/dashboard': () =>
    json({
      total_outstanding: '0.00',
      pending_customers: 0,
      paid_amount: '0.00',
      customers: 0,
      recent: [],
    }),
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
      'Import',
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
    expect(screen.getByRole('button', { name: /account menu/i })).toBeInTheDocument()
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

describe('Public payment route', () => {
  it('renders standalone: no employer navigation and no sign-in needed', async () => {
    fake.setSession(null)
    mockApi({ 'GET /api/v1/public/pay/some-token-0123': () => json({ detail: 'no' }, 404) })
    renderApp('/pay/some-token-0123')
    expect(
      await screen.findByRole('heading', { name: 'This payment page is unavailable.' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})
