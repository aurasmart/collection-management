import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', () => ({ supabase: null, authOptions: {}, createSupabase: vi.fn() }))

describe('build without Supabase configuration', () => {
  it('explains the problem on employer routes instead of redirecting in a loop', async () => {
    mockApi({})
    const { router } = renderApp('/settings')
    expect(await screen.findByText("Sign-in isn't configured")).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings')
  })

  it('disables sign-in on the login screen', async () => {
    mockApi({})
    renderApp('/login')
    expect(await screen.findByText("Sign-in isn't configured")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
  })
})
