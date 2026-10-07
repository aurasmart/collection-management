import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authEvents } from '@/lib/auth-events'
import { authError, fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const ME = { employer: { id: 'e1', name: 'Acme Traders', email: 'owner@acme.test' } }
const api = () =>
  mockApi({ 'GET /healthz': () => json({ status: 'ok' }), 'GET /api/v1/me': () => json(ME) })

beforeEach(() => {
  fake.reset()
  api()
})

async function fillLogin(email = 'owner@acme.test', password = 'correct-horse-battery') {
  await userEvent.type(await screen.findByLabelText(/email/i), email)
  await userEvent.type(screen.getByLabelText(/^password/i), password)
}

describe('route protection', () => {
  it('blocks every employer screen for signed-out users and remembers where they were going', async () => {
    const { router } = renderApp('/settings')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/settings')
  })

  it.each(['/', '/collections', '/upload', '/settings', '/anything-else'])(
    '%s never renders employer content while signed out',
    async (path) => {
      renderApp(path)
      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument()
    },
  )

  it('shows a loading state while the session is being resolved (no flash of content or redirect)', async () => {
    fake.setSession('owner@acme.test')
    const { router } = renderApp('/collections')
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i)
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/collections')
  })

  it('does not redirect-loop on the login screen when signed out', async () => {
    const { router } = renderApp('/login')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 30))
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toBe('')
  })

  it('sends an already signed-in user straight from /login to their destination', async () => {
    fake.setSession('owner@acme.test')
    const { router } = renderApp('/login?next=%2Fcollections')
    await waitFor(() => expect(router.state.location.pathname).toBe('/collections'))
  })

  it('ignores hostile "next" values after login', async () => {
    fake.setSession('owner@acme.test')
    const { router } = renderApp('/login?next=https%3A%2F%2Fevil.example')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('keeps the public payment route reachable without a session', async () => {
    mockApi({ 'GET /api/v1/public/pay/tok1234567890': () => json({ detail: 'no' }, 404) })
    renderApp('/pay/tok1234567890')
    expect(
      await screen.findByRole('heading', { name: 'This payment page is unavailable.' }),
    ).toBeInTheDocument()
  })
})

describe('login', () => {
  it('signs in and lands on the originally requested page', async () => {
    const { router } = renderApp('/login?next=%2Fcollections')
    await fillLogin()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/collections'))
    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'owner@acme.test',
      password: 'correct-horse-battery',
    })
  })

  it('validates before calling the server', async () => {
    renderApp('/login')
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter your email')).toBeInTheDocument()
    expect(screen.getByText('Enter your password')).toBeInTheDocument()
    expect(fake.auth.signInWithPassword).not.toHaveBeenCalled()
  })

  it('shows one generic message for bad credentials, keeps the email, clears and focuses the password', async () => {
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: authError({ status: 400, code: 'invalid_credentials' }),
    })
    renderApp('/login')
    await fillLogin('owner@acme.test', 'wrong-password-123')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toHaveValue('owner@acme.test')
    expect(screen.getByLabelText(/^password/i)).toHaveValue('')
    expect(screen.getByLabelText(/^password/i)).toHaveFocus()
  })

  it.each([
    [{ status: 429 }, 'Too many attempts. Try again in a few minutes.'],
    [
      { name: 'AuthRetryableFetchError', status: 0 },
      "Can't reach the server. Check your connection and try again.",
    ],
  ])('maps %j to a clear message', async (err, message) => {
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: authError(err),
    })
    renderApp('/login')
    await fillLogin()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('has a show/hide password toggle', async () => {
    renderApp('/login')
    const field = await screen.findByLabelText(/^password/i)
    expect(field).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(field).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('offers no public signup', async () => {
    renderApp('/login')
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.queryByText(/sign up|register|create account/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeInTheDocument()
  })
})

describe('session restoration and logout', () => {
  it('restores a persisted session on page load', async () => {
    fake.setSession('owner@acme.test')
    renderApp('/settings')
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('signs out of THIS browser only and returns to the login screen', async () => {
    fake.setSession('owner@acme.test')
    const { router } = renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: /account menu/i }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /sign out/i }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    // a deliberate sign-out must not look like an expiry
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('session expiry (Stage 2 S12)', () => {
  async function signedInAtSettings() {
    fake.setSession('owner@acme.test')
    const view = renderApp('/settings')
    await screen.findByRole('navigation', { name: 'Primary' })
    return view
  }

  it('shows a blocking modal over the current screen when the session is lost', async () => {
    const { router } = await signedInAtSettings()
    act(() => fake.emit('SIGNED_OUT', null))
    const dialog = await screen.findByRole('dialog', { name: 'Your session expired' })
    expect(within(dialog).getByText('owner@acme.test')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings') // same screen, content preserved
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Your session expired' })).toBeInTheDocument()
  })

  it('shows the same modal when the API rejects the token with 401', async () => {
    await signedInAtSettings()
    act(() => authEvents.emitUnauthorized())
    expect(await screen.findByRole('dialog', { name: 'Your session expired' })).toBeInTheDocument()
  })

  it('wrong password keeps the modal open with an error; the right one closes it in place', async () => {
    const { router } = await signedInAtSettings()
    act(() => fake.emit('SIGNED_OUT', null))
    const dialog = await screen.findByRole('dialog', { name: 'Your session expired' })

    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: authError({ status: 400, code: 'invalid_credentials' }),
    })
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'wrong-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign in again' }))
    expect(await within(dialog).findByText('Incorrect password.')).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/settings')
    expect(fake.auth.signInWithPassword).toHaveBeenLastCalledWith({
      email: 'owner@acme.test',
      password: 'correct-horse-battery',
    })
  })

  it('locks after three wrong passwords', async () => {
    await signedInAtSettings()
    act(() => fake.emit('SIGNED_OUT', null))
    const dialog = await screen.findByRole('dialog', { name: 'Your session expired' })
    fake.auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: authError({ status: 400, code: 'invalid_credentials' }),
    })
    for (let i = 0; i < 3; i++) {
      await userEvent.type(within(dialog).getByLabelText(/^password/i), `bad-password-${i}`)
      await userEvent.click(within(dialog).getByRole('button', { name: 'Sign in again' }))
      await waitFor(() => expect(within(dialog).getByLabelText(/^password/i)).toHaveValue(''))
    }
    expect(
      await within(dialog).findByText('Too many attempts. Try again later.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Sign in again' })).toBeDisabled()
  })

  it('"Sign out" goes to login and remembers the page', async () => {
    const { router } = await signedInAtSettings()
    act(() => fake.emit('SIGNED_OUT', null))
    const dialog = await screen.findByRole('dialog', { name: 'Your session expired' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/settings')
  })
})
