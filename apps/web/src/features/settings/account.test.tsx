import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authError, fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const ME = { employer: { id: 'e1', name: 'Acme Traders', email: 'owner@acme.test' } }

async function open(path = '/settings/account') {
  fake.setSession('owner@acme.test')
  mockApi({ 'GET /healthz': () => json({ status: 'ok' }), 'GET /api/v1/me': () => json(ME) })
  const view = renderApp(path)
  await screen.findByRole('heading', { name: path.endsWith('security') ? 'Security' : 'Account' })
  return view
}

const field = (label: string) =>
  screen.getByLabelText(new RegExp(`^${label}`), { selector: 'input' })
const submit = () => userEvent.click(screen.getByRole('button', { name: 'Change password' }))

async function fill(current: string, next: string, confirm = next) {
  await userEvent.type(field('Current password'), current)
  await userEvent.type(field('New password'), next)
  await userEvent.type(field('Confirm new password'), confirm)
}

beforeEach(() => fake.reset())

describe('Account', () => {
  it('shows the signed-in email and the account name', async () => {
    await open()
    const card = screen.getByRole('region', { name: 'Your account' })
    expect(within(card).getByText('owner@acme.test')).toBeInTheDocument()
    expect(await within(card).findByText('Acme Traders')).toBeInTheDocument()
  })

  it('Sign out ends this browser session and goes to the sign-in screen', async () => {
    const { router } = await open()
    const card = screen.getByRole('region', { name: 'Your account' })
    await userEvent.click(within(card).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})

describe('Change password', () => {
  it('requires every field', async () => {
    await open()
    await submit()
    expect(await screen.findByText('Enter your current password')).toBeInTheDocument()
    expect(screen.getByText('Use at least 8 characters')).toBeInTheDocument()
    expect(screen.getByText('Re-enter your new password')).toBeInTheDocument()
    expect(fake.auth.updateUser).not.toHaveBeenCalled()
  })

  it('enforces the 8-character minimum and a matching confirmation', async () => {
    await open()
    await fill('old-password-123', 'short', 'different')
    await submit()
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument()
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
    expect(fake.auth.updateUser).not.toHaveBeenCalled()
  })

  it('refuses a new password equal to the current one', async () => {
    await open()
    await fill('same-password-123', 'same-password-123')
    await submit()
    expect(
      await screen.findByText('Choose a password different from your current one'),
    ).toBeInTheDocument()
    expect(fake.auth.updateUser).not.toHaveBeenCalled()
  })

  it('verifies the current password, then sets the new one, then confirms and clears the form', async () => {
    await open()
    await fill('old-password-123', 'brand-new-password-456')
    await submit()
    expect(await screen.findByText('Password changed')).toBeInTheDocument()
    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'owner@acme.test',
      password: 'old-password-123',
    })
    expect(fake.auth.updateUser).toHaveBeenCalledWith({ password: 'brand-new-password-456' })
    expect(field('Current password')).toHaveValue('')
    expect(field('New password')).toHaveValue('')
  })

  it('a wrong current password changes nothing', async () => {
    await open()
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: authError({ status: 400, code: 'invalid_credentials' }),
    })
    await fill('wrong-password-1', 'brand-new-password-456')
    await submit()
    expect(await screen.findByText('Your current password is incorrect.')).toBeInTheDocument()
    expect(fake.auth.updateUser).not.toHaveBeenCalled()
  })

  it.each([
    ['same_password', 'Choose a password different from your current one.'],
    ['weak_password', 'That password is too easy to guess. Try a longer or less common one.'],
    ['over_request_rate_limit', 'Too many attempts. Try again in a few minutes.'],
  ])('explains a %s failure from the server', async (code, message) => {
    await open()
    fake.auth.updateUser.mockResolvedValueOnce({
      data: {},
      error: authError({ status: code === 'over_request_rate_limit' ? 429 : 422, code }),
    })
    await fill('old-password-123', 'brand-new-password-456')
    await submit()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByText('Password changed')).not.toBeInTheDocument()
  })

  it('explains a network failure calmly', async () => {
    await open()
    fake.auth.updateUser.mockRejectedValueOnce(new Error('offline'))
    await fill('old-password-123', 'brand-new-password-456')
    await submit()
    expect(
      await screen.findByText("Can't reach the server. Check your connection and try again."),
    ).toBeInTheDocument()
  })
})

describe('Security', () => {
  it('explains the password rules and when the password is asked again', async () => {
    await open('/settings/security')
    expect(screen.getByText(/at least 8 characters/)).toBeInTheDocument()
    expect(screen.getByText('When we ask for your password again')).toBeInTheDocument()
    expect(screen.getByText(/within the last 5 minutes/)).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: /Payment details|Company profile|Account/ })
    expect(links.length).toBeGreaterThanOrEqual(3)
  })
})
