import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authError, fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const field = (label: string) =>
  screen.getByLabelText(new RegExp(`^${label}`), { selector: 'input' })

async function fillValid(over: Record<string, string> = {}) {
  const v = {
    'Full name': 'Asha Rao',
    'Work email': 'Asha@Acme.example',
    'Company / business name': 'Acme Traders',
    'Phone number': '98765 43210',
    Password: 'a-long-password-123',
    'Confirm password': 'a-long-password-123',
    ...over,
  }
  for (const [label, value] of Object.entries(v)) {
    if (value) await userEvent.type(field(label), value)
  }
}
const submit = () => userEvent.click(screen.getByRole('button', { name: 'Create account' }))

async function open() {
  renderApp('/signup')
  await screen.findByRole('heading', { name: 'Create your account' })
}

beforeEach(() => fake.reset())

describe('sign up page', () => {
  it('shows the Latigid logo and the product name', async () => {
    await open()
    expect(screen.getByRole('img', { name: 'Latigid' })).toBeInTheDocument()
    expect(screen.getByText('Collection Management')).toBeInTheDocument()
  })

  it('renders the short registration form in the same card as sign in', async () => {
    await open()
    for (const l of [
      'Full name',
      'Work email',
      'Company / business name',
      'Phone number',
      'Password',
      'Confirm password',
    ]) {
      expect(field(l)).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
    expect(screen.getByLabelText(/Phone number \(optional\)/)).not.toBeRequired()
    expect(screen.getByLabelText(/^Full name/)).toBeRequired()
    // short and professional: none of the Company Profile fields
    for (const hidden of [/GSTIN/, /PAN/, /Address/, /Website/, /Legal/]) {
      expect(screen.queryByLabelText(hidden)).not.toBeInTheDocument()
    }
  })

  it('links to sign in, and sign in links back to sign up', async () => {
    await open()
    expect(screen.getByText('Already have an account?')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  it('explains every required field that is empty and sends nothing', async () => {
    await open()
    await submit()
    expect(await screen.findByText('Enter your full name')).toBeInTheDocument()
    expect(screen.getByText('Enter your work email')).toBeInTheDocument()
    expect(screen.getByText('Enter your company or business name')).toBeInTheDocument()
    expect(screen.getByText('Use at least 8 characters')).toBeInTheDocument()
    expect(screen.getByText('Re-enter your password')).toBeInTheDocument()
    expect(fake.auth.signUp).not.toHaveBeenCalled()
  })

  it.each([
    ['Work email', 'not-an-email', 'Enter a valid email address'],
    ['Phone number', '12', 'Enter a valid phone number'],
    ['Password', 'short', 'Use at least 8 characters'],
  ])('%s "%s" is explained', async (label, value, message) => {
    await open()
    await fillValid({ [label]: '' })
    await userEvent.type(field(label), value)
    if (label === 'Password') await userEvent.type(field('Confirm password'), value)
    await submit()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(fake.auth.signUp).not.toHaveBeenCalled()
  })

  it('requires the two passwords to match', async () => {
    await open()
    await fillValid({ 'Confirm password': 'a-different-password-9' })
    await submit()
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument()
    expect(fake.auth.signUp).not.toHaveBeenCalled()
  })

  it('creates the login with the details as metadata and asks to confirm the email', async () => {
    await open()
    await fillValid()
    await submit()
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText('asha@acme.example')).toBeInTheDocument() // normalised
    const arg = fake.auth.signUp.mock.calls[0]![0] as {
      email: string
      password: string
      options: { data: Record<string, string>; emailRedirectTo: string }
    }
    expect(arg.email).toBe('asha@acme.example')
    expect(arg.options.data).toEqual({
      full_name: 'Asha Rao',
      company_name: 'Acme Traders',
      phone: '98765 43210',
    })
    expect(arg.options.emailRedirectTo).toMatch(/#\/login\?confirmed=1$/)
    expect(JSON.stringify(arg.options)).not.toMatch(/employer/i)
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login')
  })

  it('leaves the phone out when it is blank', async () => {
    await open()
    await fillValid({ 'Phone number': '' })
    await submit()
    await screen.findByRole('heading', { name: 'Check your email' })
    const arg = fake.auth.signUp.mock.calls[0]![0] as { options: { data: object } }
    expect(arg.options.data).not.toHaveProperty('phone')
  })

  it('goes straight in when the project does not require email confirmation', async () => {
    fake.auth.signUp.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', identities: [{}] },
        session: { access_token: 't', user: { id: 'u1', email: 'a@b.test' } },
      },
      error: null,
    })
    mockApi({
      'GET /api/v1/me': () => json({ employer: { id: 'e', name: 'Asha Rao', email: 'a@b.test' } }),
    })
    const { router } = renderApp('/signup')
    await screen.findByRole('heading', { name: 'Create your account' })
    await fillValid()
    await submit()
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/signup'))
  })

  it.each([
    [
      'an error from Supabase',
      {
        data: { user: null, session: null },
        error: authError({ status: 422, code: 'user_already_exists' }),
      },
    ],
    [
      'a Supabase answer with no identities',
      { data: { user: { id: 'x', identities: [] }, session: null }, error: null },
    ],
  ])('refuses a duplicate email (%s) and offers sign in', async (_name, response) => {
    fake.auth.signUp.mockResolvedValueOnce(response as never)
    await open()
    await fillValid()
    await submit()
    expect(
      await screen.findByText('An account with this email already exists. Sign in instead.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Check your email' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })

  it.each([
    ['weak_password', 422, 'That password is too easy to guess. Try a longer or less common one.'],
    ['over_email_send_rate_limit', 429, 'Too many attempts. Try again in a few minutes.'],
  ])('explains a %s failure', async (code, status, message) => {
    fake.auth.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: authError({ status, code }),
    } as never)
    await open()
    await fillValid()
    await submit()
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('explains a network failure and keeps what was typed', async () => {
    fake.auth.signUp.mockRejectedValueOnce(new Error('offline'))
    await open()
    await fillValid()
    await submit()
    expect(
      await screen.findByText("Can't reach the server. Check your connection and try again."),
    ).toBeInTheDocument()
    expect(field('Company / business name')).toHaveValue('Acme Traders')
  })

  it('sends a signed-in user to the app instead of the form', async () => {
    fake.setSession('owner@acme.test')
    mockApi({
      'GET /api/v1/me': () => json({ employer: { id: 'e', name: 'A', email: 'o@a.test' } }),
    })
    const { router } = renderApp('/signup')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('stays out of the way of the guarded app (the page is public)', async () => {
    const { router } = renderApp('/signup')
    await screen.findByRole('heading', { name: 'Create your account' })
    expect(router.state.location.pathname).toBe('/signup')
    expect(
      within(document.body).queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
  })
})

describe('first sign-in after sign up', () => {
  const ME = { employer: { id: 'e1', name: 'Asha Rao', email: 'asha@acme.example' } }

  it('creates the workspace when the account has none, then onboards on Company profile', async () => {
    fake.setSession('asha@acme.example')
    let hasWorkspace = false
    const api = mockApi({
      'GET /healthz': () => json({ status: 'ok' }),
      'GET /api/v1/me': () => (hasWorkspace ? json(ME) : json({ detail: 'No workspace' }, 403)),
      'POST /api/v1/account/setup': () => {
        hasWorkspace = true
        return json({ created: true })
      },
      'GET /api/v1/settings/company': () =>
        json({
          display_name: 'Acme Traders',
          has_logo: false,
          saved: true,
          updated_at: null,
          recent_changes: [],
          legal_name: null,
          address: null,
          city: null,
          state: null,
          pin: null,
          gstin: null,
          pan: null,
          contact_person: null,
          phone: null,
          email: null,
          website: null,
        }),
    })
    const { router } = renderApp('/')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/company'))
    expect(api.called('POST /api/v1/account/setup')).toHaveLength(1)
    expect(api.called('POST /api/v1/account/setup')[0]!.body).toBeNull() // nothing for the browser to choose
    expect(
      await screen.findByText('Welcome! Step 1 of 2: your company details'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: 'Next: Payment details' }))
    expect(await screen.findByText('Step 2 of 2: how customers pay you')).toBeInTheDocument()
  })

  it('"Skip to dashboard" ends the onboarding for good', async () => {
    fake.setSession('asha@acme.example')
    let hasWorkspace = false
    mockApi({
      'GET /api/v1/me': () => (hasWorkspace ? json(ME) : json({ detail: 'x' }, 403)),
      'POST /api/v1/account/setup': () => {
        hasWorkspace = true
        return json({ created: true })
      },
      'GET /api/v1/settings/company': () =>
        json({
          display_name: 'A',
          has_logo: false,
          saved: true,
          updated_at: null,
          recent_changes: [],
          legal_name: null,
          address: null,
          city: null,
          state: null,
          pin: null,
          gstin: null,
          pan: null,
          contact_person: null,
          phone: null,
          email: null,
          website: null,
        }),
      'GET /api/v1/dashboard': () =>
        json({
          total_outstanding: '0.00',
          pending_customers: 0,
          paid_amount: '0.00',
          customers: 0,
          recent: [],
        }),
    })
    renderApp('/')
    await userEvent.click(await screen.findByRole('link', { name: 'Skip to dashboard' }))
    expect(window.localStorage.getItem('collections.onboarding')).toBeNull()
  })

  it('does nothing special for an existing account (no setup call, no onboarding)', async () => {
    fake.setSession('owner@acme.test')
    const api = mockApi({
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
    const { router } = renderApp('/')
    await screen.findByRole('navigation', { name: 'Primary' })
    expect(api.called('POST /api/v1/account/setup')).toHaveLength(0)
    expect(router.state.location.pathname).toBe('/')
  })

  it('does not onboard twice when the workspace already existed (a second tab)', async () => {
    fake.setSession('asha@acme.example')
    let first = true
    mockApi({
      'GET /api/v1/me': () => (first ? json({ detail: 'x' }, 403) : json(ME)),
      'POST /api/v1/account/setup': () => {
        first = false
        return json({ created: false })
      },
      'GET /api/v1/dashboard': () =>
        json({
          total_outstanding: '0.00',
          pending_customers: 0,
          paid_amount: '0.00',
          customers: 0,
          recent: [],
        }),
    })
    const { router } = renderApp('/')
    await screen.findByRole('navigation', { name: 'Primary' })
    expect(router.state.location.pathname).toBe('/')
  })
})
