import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})
const readImageSize = vi.hoisted(() => vi.fn())
vi.mock('@/lib/image', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readImageSize,
}))

const ME = { employer: { id: 'e1', name: 'Acme Traders', email: 'owner@acme.test' } }
const URL_ = '/api/v1/settings/company'

function profile(over: Record<string, unknown> = {}) {
  return {
    display_name: 'Acme Traders',
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
    has_logo: false,
    saved: true,
    updated_at: '2026-10-14T10:00:00Z',
    recent_changes: [],
    ...over,
  }
}

async function open(initial = profile(), extra: Parameters<typeof mockApi>[0] = {}, path = URL_) {
  fake.setSession('owner@acme.test')
  const api = mockApi({
    'GET /healthz': () => json({ status: 'ok' }),
    'GET /api/v1/me': () => json(ME),
    [`GET ${URL_}`]: () => json(initial),
    [`GET ${URL_}/logo`]: () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
    [`PUT ${URL_}`]: async (req) =>
      json({ ...initial, ...(await req.clone().json()), updated_at: '2026-10-15T10:00:00Z' }),
    ...extra,
  })
  const view = renderApp(path.replace('/api/v1', ''))
  await screen.findByRole('form', { name: 'Company profile' })
  return { api, ...view }
}

const box = (name: string | RegExp) => screen.getByRole('textbox', { name })
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save company profile' }))
async function confirmPassword() {
  const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
  await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
}

beforeEach(() => {
  fake.reset()
  readImageSize.mockReset()
  readImageSize.mockResolvedValue({ width: 400, height: 400 })
})

describe('Settings hub', () => {
  it('/settings opens Company profile and offers the four sections', async () => {
    fake.setSession('owner@acme.test')
    mockApi({
      'GET /healthz': () => json({ status: 'ok' }),
      'GET /api/v1/me': () => json(ME),
      [`GET ${URL_}`]: () => json(profile()),
    })
    const { router } = renderApp('/settings')
    await screen.findByRole('form', { name: 'Company profile' })
    expect(router.state.location.pathname).toBe('/settings/company')
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Company profile', 'Payment details', 'Account', 'Security'])
    expect(within(nav).getByRole('link', { name: 'Company profile' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('the sidebar keeps the single "Settings" item', async () => {
    await open()
    const primary = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(primary).getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(within(primary).queryByRole('link', { name: 'Payment details' })).not.toBeInTheDocument()
  })
})

describe('Company profile: states', () => {
  it('shows a skeleton while loading', async () => {
    fake.setSession('owner@acme.test')
    mockApi({
      'GET /api/v1/me': () => json(ME),
      [`GET ${URL_}`]: () => json(profile()),
    })
    renderApp('/settings/company')
    expect(await screen.findByText('Loading company profile…')).toBeInTheDocument()
    expect(await screen.findByRole('form', { name: 'Company profile' })).toBeInTheDocument()
  })

  it('shows an error with Retry', async () => {
    fake.setSession('owner@acme.test')
    let fail = true
    mockApi({
      'GET /api/v1/me': () => json(ME),
      [`GET ${URL_}`]: () => (fail ? json({ detail: 'boom' }, 500) : json(profile())),
    })
    renderApp('/settings/company')
    expect(await screen.findByText("Couldn't load the company profile")).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('form', { name: 'Company profile' })).toBeInTheDocument()
  })

  it('pre-fills the account name until the profile is first saved', async () => {
    await open(profile({ saved: false, updated_at: null }))
    expect(box(/^Company \/ business display name/)).toHaveValue('Acme Traders')
  })

  it('shows every field and tells the employer what customers can see', async () => {
    await open()
    for (const label of [
      /^Company \/ business display name/,
      'Legal / business name',
      'Address',
      'City',
      'State',
      'PIN code',
      'GSTIN',
      'PAN',
      'Contact person',
      'Contact phone',
      'Contact email',
      'Website',
    ]) {
      expect(box(label)).toBeInTheDocument()
    }
    expect(screen.getByText(/never shown to customers/)).toBeInTheDocument()
  })

  it('lists recent changes by who, when and field name only', async () => {
    await open(
      profile({
        recent_changes: [
          { at: '2026-10-14T10:42:00Z', actor: 'owner@acme.test', fields: ['gstin', 'logo'] },
        ],
      }),
    )
    const card = screen.getByRole('heading', { name: 'Recent changes' }).closest('section')!
    expect(within(card).getByText('You')).toBeInTheDocument()
    expect(within(card).getByText('GSTIN, Logo')).toBeInTheDocument()
  })
})

describe('Company profile: validation', () => {
  it('requires a display name', async () => {
    const { api } = await open()
    await userEvent.clear(box(/^Company \/ business display name/))
    await save()
    expect(await screen.findByText('Enter at least 2 characters')).toBeInTheDocument()
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
  })

  it.each([
    ['PIN code', '12345', 'Enter a 6-digit PIN code'],
    ['GSTIN', 'BADGST', 'Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5'],
    ['PAN', '12345', 'Enter a valid 10-character PAN, like ABCDE1234F'],
    ['Contact phone', '12', 'Enter a valid phone number'],
    ['Contact email', 'nope', 'Enter a valid email address'],
    ['Website', 'javascript:alert(1)', 'Enter a valid website address, like https://example.com'],
  ])('%s "%s" is explained, not sent', async (label, value, message) => {
    const { api } = await open()
    await userEvent.type(box(label), value)
    await save()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
  })

  it('accepts valid optional values (lower-case GSTIN is upper-cased)', async () => {
    const { api } = await open()
    await userEvent.type(box('GSTIN'), '27abcde1234f1z5')
    await userEvent.type(box('PIN code'), '411001')
    await userEvent.type(box('Website'), 'acme.example')
    await save()
    await confirmPassword()
    await screen.findByText('Company profile saved')
    expect(api.called(`PUT ${URL_}`)[0]!.body).toMatchObject({
      gstin: '27ABCDE1234F1Z5',
      pin: '411001',
      website: 'acme.example',
    })
  })
})

describe('Company profile: saving', () => {
  it('a customer-visible change asks for the password first; nothing is sent until confirmed', async () => {
    const { api } = await open()
    const name = box(/^Company \/ business display name/)
    await userEvent.clear(name)
    await userEvent.type(name, 'Acme Wholesale')
    await save()
    await screen.findByRole('dialog', { name: "Confirm it's you" })
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
    await confirmPassword()
    expect(await screen.findByText('Company profile saved')).toBeInTheDocument()
    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'owner@acme.test',
      password: 'correct-horse-battery',
    })
    expect(api.called(`PUT ${URL_}`)[0]!.body).toMatchObject({ display_name: 'Acme Wholesale' })
  })

  it('a private-only change (PAN) saves without asking for a password', async () => {
    const { api } = await open()
    await userEvent.type(box('PAN'), 'ABCDE1234F')
    await save()
    expect(await screen.findByText('Company profile saved')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fake.auth.signInWithPassword).not.toHaveBeenCalled()
    expect(api.called(`PUT ${URL_}`)).toHaveLength(1)
  })

  it('the very first save asks for the password', async () => {
    await open(profile({ saved: false, updated_at: null }))
    await userEvent.type(box('City'), 'Pune')
    await save()
    expect(await screen.findByRole('dialog', { name: "Confirm it's you" })).toBeInTheDocument()
  })

  it('cancelling the confirmation keeps the edits and sends nothing', async () => {
    const { api } = await open()
    await userEvent.type(box('City'), 'Pune')
    await save()
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
    expect(box('City')).toHaveValue('Pune')
  })

  it('asks again if the server says the confirmation lapsed', async () => {
    let first = true
    const { api } = await open(profile(), {
      [`PUT ${URL_}`]: () => {
        if (first) {
          first = false
          return json({ detail: { code: 'reauth_required', message: 'confirm' } }, 403)
        }
        return json(profile({ city: 'Pune' }))
      },
    })
    await userEvent.type(box('City'), 'Pune')
    await save()
    await confirmPassword()
    await waitFor(() => expect(api.called(`PUT ${URL_}`)).toHaveLength(1))
    await confirmPassword()
    expect(await screen.findByText('Company profile saved')).toBeInTheDocument()
  })

  it('maps a server 422 onto the right field', async () => {
    await open(profile(), {
      [`PUT ${URL_}`]: () =>
        json(
          {
            detail: [
              {
                loc: ['body', 'gstin'],
                msg: 'Value error, Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5',
                type: 'value_error',
              },
            ],
          },
          422,
        ),
    })
    await userEvent.type(box('City'), 'Pune')
    await save()
    await confirmPassword()
    expect(
      await screen.findByText('Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5'),
    ).toBeInTheDocument()
  })

  it('shows a calm error and keeps the form when saving fails', async () => {
    await open(profile(), { [`PUT ${URL_}`]: () => json({ detail: 'boom' }, 500) })
    await userEvent.type(box('City'), 'Pune')
    await save()
    await confirmPassword()
    expect(
      await screen.findByText("Couldn't save. Your previous details are unchanged."),
    ).toBeInTheDocument()
    expect(box('City')).toHaveValue('Pune')
  })

  it('never sends an employer id', async () => {
    const { api } = await open()
    await userEvent.type(box('PAN'), 'ABCDE1234F')
    await save()
    await screen.findByText('Company profile saved')
    for (const c of api.calls) {
      expect(JSON.stringify(c.body ?? '')).not.toMatch(/employer/i)
      expect(c.request.url).not.toMatch(/employer/i)
    }
  })

  it('asks before leaving unsaved changes', async () => {
    const { router } = await open()
    await userEvent.type(box('City'), 'Pune')
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    expect(router.state.location.pathname).toBe('/settings/company')
    expect(box('City')).toHaveValue('Pune')
  })
})

describe('Company logo', () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' })
  const fileInput = () => screen.getByLabelText('Company logo image file') as HTMLInputElement

  it('rejects SVG, oversize and tiny images before upload', async () => {
    const { api } = await open()
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(fileInput(), new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }))
    expect(await screen.findByText(/Upload a PNG, JPG or WebP/)).toBeInTheDocument()
    await user.upload(
      fileInput(),
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
    )
    expect(await screen.findByText('This image is larger than 2 MB.')).toBeInTheDocument()
    readImageSize.mockResolvedValueOnce({ width: 32, height: 32 })
    await user.upload(fileInput(), png())
    expect(await screen.findByText(/too small/)).toBeInTheDocument()
    expect(api.calls.filter((c) => c.request.method !== 'GET')).toHaveLength(0)
  })

  it('uploads the logo first, then saves the profile, after password confirmation', async () => {
    const { api } = await open(profile(), {
      [`PUT ${URL_}/logo`]: () => json(profile({ has_logo: true })),
      [`PUT ${URL_}`]: () => json(profile({ has_logo: true })),
    })
    await userEvent.upload(fileInput(), png())
    expect(screen.getByAltText('Current company logo')).toBeInTheDocument() // preview
    await save()
    await screen.findByRole('dialog', { name: "Confirm it's you" })
    expect(api.called(`PUT ${URL_}/logo`)).toHaveLength(0) // nothing uploaded before confirmation
    await confirmPassword()
    expect(await screen.findByText('Company profile saved')).toBeInTheDocument()
    const order = api.calls.filter((c) => c.request.method === 'PUT').map((c) => c.key)
    expect(order).toEqual([`PUT ${URL_}/logo`, `PUT ${URL_}`])
    const sent = (api.called(`PUT ${URL_}/logo`)[0]!.body as FormData).get('file') as Blob
    expect(sent.type).toBe('image/png')
  })

  it('shows the stored logo through an authenticated fetch (blob URL)', async () => {
    const { api } = await open(profile({ has_logo: true }))
    const img = await screen.findByAltText('Current company logo')
    expect(img).toHaveAttribute('src', 'blob:mock')
    expect(api.called(`GET ${URL_}/logo`)[0]!.request.headers.get('authorization')).toBe(
      'Bearer test-access-token',
    )
  })

  it('removes the logo after saving', async () => {
    const { api } = await open(profile({ has_logo: true }), {
      [`DELETE ${URL_}/logo`]: () => json(profile({ has_logo: false })),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove logo' }))
    expect(screen.getByText('The logo will be removed when you save.')).toBeInTheDocument()
    await save()
    await confirmPassword()
    expect(await screen.findByText('Company profile saved')).toBeInTheDocument()
    const order = api.calls
      .filter((c) => ['PUT', 'DELETE'].includes(c.request.method))
      .map((c) => c.key)
    expect(order).toEqual([`PUT ${URL_}`, `DELETE ${URL_}/logo`])
  })
})
