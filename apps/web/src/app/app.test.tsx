import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { routeObjects } from '@/app/router'
import { NAV_ITEMS } from '@/app/shell/nav'

function renderAt(path: string) {
  const router = createMemoryRouter(routeObjects, { initialEntries: [path] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('App shell', () => {
  it('has exactly the four approved primary navigation items', () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual([
      'Dashboard',
      'Collections',
      'Upload',
      'Settings',
    ])
  })

  it('renders landmarks, skip link and primary nav', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'ok' }))),
    )
    renderAt('/')
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    for (const item of NAV_ITEMS) {
      expect(nav).toContainElement(screen.getByRole('link', { name: item.label }))
    }
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page')
  })

  it('marks the active section', () => {
    renderAt('/collections')
    expect(screen.getByRole('link', { name: 'Collections' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current')
  })

  it('shows a not-found page inside the shell for unknown routes', () => {
    renderAt('/nope')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
  })
})

describe('Connectivity diagnostics', () => {
  it('reports the backend as reachable when /healthz answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'ok' }))),
    )
    renderAt('/')
    expect(await screen.findByText(/API reachable \(ok\)/)).toBeInTheDocument()
  })

  it('shows a clear error when the backend is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down'))),
    )
    renderAt('/')
    expect(await screen.findByText('API unreachable')).toBeInTheDocument()
  })

  it('does not claim to be signed in without a Supabase configuration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'ok' }))),
    )
    renderAt('/')
    await waitFor(() => expect(screen.getByText(/Not configured/)).toBeInTheDocument())
  })
})

describe('Public payment route', () => {
  it('renders standalone (no employer navigation) and makes no API call in Phase 0', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderAt('/pay/some-token')
    expect(screen.getByRole('heading', { name: 'Payment page' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('some-token')
  })
})
