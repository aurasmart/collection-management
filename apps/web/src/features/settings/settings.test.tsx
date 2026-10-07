import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authError, fake } from '@/test/fake-supabase'
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
const URL_ = '/api/v1/settings/payment'
const COMPANY = {
  display_name: 'Acme Traders',
  has_logo: false,
  saved: true,
  updated_at: '2026-10-14T10:00:00Z',
  recent_changes: [],
}

function settings(over: Record<string, unknown> = {}) {
  return {
    upi_id: null,
    upi_number: null,
    bank_name: null,
    account_name: null,
    account_number: null,
    ifsc: null,
    upi_enabled: false,
    upi_number_enabled: false,
    qr_enabled: false,
    bank_enabled: false,
    has_qr: false,
    updated_at: '2026-10-14T10:00:00Z',
    recent_changes: [],
    ...over,
  }
}

function setup(initial = settings(), extra: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET /healthz': () => json({ status: 'ok' }),
    'GET /api/v1/me': () => json(ME),
    'GET /api/v1/settings/company': () => json(COMPANY),
    [`GET ${URL_}`]: () => json(initial),
    [`GET ${URL_}/qr`]: () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
    [`PUT ${URL_}`]: async (req) =>
      json({ ...initial, ...(await req.clone().json()), updated_at: '2026-10-15T10:00:00Z' }),
    ...extra,
  })
  return api
}

async function open(initial = settings(), extra: Parameters<typeof mockApi>[0] = {}) {
  fake.setSession('owner@acme.test')
  const api = setup(initial, extra)
  const view = renderApp('/settings/payment')
  await screen.findByRole('form', { name: 'Payment details' })
  return { api, ...view }
}

const box = (name: string | RegExp) => screen.getByRole('textbox', { name })
async function confirmPasswordDialog() {
  const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
  await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
}
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save payment details' }))

beforeEach(() => {
  fake.reset()
  readImageSize.mockReset()
  readImageSize.mockResolvedValue({ width: 400, height: 400 })
})

describe('loading / empty / error states', () => {
  it('shows a skeleton while loading, then the form', async () => {
    fake.setSession('owner@acme.test')
    setup()
    renderApp('/settings/payment')
    expect(await screen.findByText('Loading payment settings…')).toBeInTheDocument()
    expect(await screen.findByRole('form', { name: 'Payment details' })).toBeInTheDocument()
  })

  it('first-time employers see the setup prompt', async () => {
    await open(settings({ updated_at: null }))
    expect(
      screen.getByText('Add your payment details so customers know how to pay.'),
    ).toBeInTheDocument()
  })

  it('warns when no payment method is enabled yet', async () => {
    await open()
    expect(screen.getByText('No payment method enabled')).toBeInTheDocument()
    expect(screen.getByText(/You can't create payment requests yet/)).toBeInTheDocument()
  })

  it('shows an error with Retry when settings cannot be loaded', async () => {
    fake.setSession('owner@acme.test')
    let fail = true
    setup(settings(), {
      [`GET ${URL_}`]: () => (fail ? json({ detail: 'boom' }, 500) : json(settings())),
    })
    renderApp('/settings/payment')
    expect(await screen.findByText("Couldn't load payment settings")).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('form', { name: 'Payment details' })).toBeInTheDocument()
  })

  it('lists recent changes by who, when and field name only', async () => {
    await open(
      settings({
        recent_changes: [
          { at: '2026-10-14T10:42:00Z', actor: 'owner@acme.test', fields: ['upi_id', 'qr_code'] },
          { at: '2026-10-13T08:00:00Z', actor: 'other@acme.test', fields: ['bank_name'] },
        ],
      }),
    )
    const card = screen.getByRole('heading', { name: 'Recent changes' }).closest('section')!
    expect(within(card).getByText('You')).toBeInTheDocument()
    expect(within(card).getByText('other@acme.test')).toBeInTheDocument()
    expect(within(card).getByText('UPI ID, QR code')).toBeInTheDocument()
    expect(within(card).getByText(/14 Oct 2026/)).toBeInTheDocument()
  })
})

describe('client-side validation', () => {
  it('blocks an invalid UPI ID with an inline message and sends nothing', async () => {
    const { api } = await open()
    await userEvent.type(box('UPI ID'), 'not-a-upi-id')
    await save()
    expect(await screen.findByText('Enter a valid UPI ID, like name@bank')).toBeInTheDocument()
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
  })

  it.each([
    ['UPI number', '12345', 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9'],
    ['IFSC', 'HDFC1234567', 'Enter a valid IFSC, like HDFC0001234'],
    ['Account number', '123', 'Account number must be 9 to 18 digits'],
  ])('%s: %s -> %s', async (label, value, message) => {
    await open()
    await userEvent.type(box(new RegExp(`^${label}$`)), value)
    await save()
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('requires an enabled method to be fully configured', async () => {
    await open()
    await userEvent.click(screen.getByRole('switch', { name: 'Show UPI ID to customers' }))
    await save()
    expect(await screen.findByText('Enter your UPI ID to show it to customers')).toBeInTheDocument()
  })

  it('requires the account number to be re-entered identically', async () => {
    await open()
    await userEvent.type(box('Account number'), '50100234567890')
    await userEvent.type(box('Re-enter account number'), '50100234567891')
    await save()
    expect(await screen.findByText('Account numbers do not match')).toBeInTheDocument()
  })
})

describe('saving: re-authentication for sensitive changes', () => {
  it('a payment-detail change asks for the password first; nothing is sent until it is confirmed', async () => {
    const { api } = await open()
    await userEvent.type(box('UPI ID'), 'acme@okaxis')
    await userEvent.click(screen.getByRole('switch', { name: 'Show UPI ID to customers' }))
    await save()

    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    expect(await screen.findByText('Payment details saved')).toBeInTheDocument()

    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'owner@acme.test',
      password: 'correct-horse-battery',
    })
    const [put] = api.called(`PUT ${URL_}`)
    expect(put!.body).toMatchObject({ upi_id: 'acme@okaxis', upi_enabled: true })
  })

  it('a wrong password does not change anything', async () => {
    const { api } = await open()
    await userEvent.type(box('UPI number'), '9876543210')
    await save()
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    fake.auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: authError({ status: 400, code: 'invalid_credentials' }),
    })
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'wrong-password-1')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    expect(await within(dialog).findByText('Incorrect password.')).toBeInTheDocument()
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
  })

  it('cancelling the confirmation changes nothing and keeps the edits', async () => {
    const { api } = await open()
    await userEvent.type(box('UPI ID'), 'acme@okaxis')
    await save()
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
    expect(box('UPI ID')).toHaveValue('acme@okaxis')
  })

  it('if the server says the confirmation lapsed (403 reauth_required), it asks again and nothing is applied', async () => {
    let first = true
    const { api } = await open(settings(), {
      [`PUT ${URL_}`]: () => {
        if (first) {
          first = false
          return json({ detail: { code: 'reauth_required', message: 'confirm' } }, 403)
        }
        return json(settings({ upi_id: 'acme@okaxis' }))
      },
    })
    await userEvent.type(box('UPI ID'), 'acme@okaxis')
    await save()
    let dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    // server rejected: the dialog comes back
    await waitFor(() => expect(api.called(`PUT ${URL_}`)).toHaveLength(1))
    dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    expect(screen.queryByText('Payment details saved')).not.toBeInTheDocument()
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    expect(await screen.findByText('Payment details saved')).toBeInTheDocument()
  })
})

describe('saving: server responses', () => {
  it('maps a server 422 onto the right field', async () => {
    await open(settings(), {
      [`PUT ${URL_}`]: () =>
        json(
          {
            detail: [
              {
                loc: ['body', 'upi_id'],
                msg: 'Value error, Enter a valid UPI ID, like name@bank',
                type: 'value_error',
              },
            ],
          },
          422,
        ),
    })
    await userEvent.type(box('UPI ID'), 'looks@valid')
    await save()
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    expect(await screen.findByText('Enter a valid UPI ID, like name@bank')).toBeInTheDocument()
  })

  it('shows a calm error and keeps the form when saving fails', async () => {
    await open(settings(), { [`PUT ${URL_}`]: () => json({ detail: 'boom' }, 500) })
    await userEvent.type(box('UPI number'), '9876543210')
    await save()
    await confirmPasswordDialog()
    expect(
      await screen.findByText("Couldn't save. Your previous details are unchanged."),
    ).toBeInTheDocument()
    expect(box('UPI number')).toHaveValue('9876543210')
  })

  it('never sends an employer id, in the body or the URL', async () => {
    const { api } = await open()
    await userEvent.type(box('UPI number'), '9876543210')
    await save()
    await confirmPasswordDialog()
    await screen.findByText('Payment details saved')
    for (const c of api.calls) {
      expect(JSON.stringify(c.body ?? '')).not.toMatch(/employer/i)
      expect(c.request.url).not.toMatch(/employer/i)
    }
  })

  it('no longer has a display name: that lives in the Company profile', async () => {
    await open()
    expect(screen.queryByRole('textbox', { name: /display name/i })).not.toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: 'Company profile' })
    expect(links.some((l) => l.getAttribute('href') === '/settings/company')).toBe(true)
  })
})

describe('preview', () => {
  it('reflects unsaved values, is labelled as a sample and creates nothing', async () => {
    const { api } = await open(settings({ upi_id: null }))
    await userEvent.type(box('UPI ID'), 'acme@okaxis')
    await userEvent.click(screen.getByRole('switch', { name: 'Show UPI ID to customers' }))
    const preview = screen.getByRole('region', { name: 'How this will look to customers' })
    expect(within(preview).getByText('Preview')).toBeInTheDocument()
    expect(within(preview).getByText(/not a real payment request/)).toBeInTheDocument()
    expect(within(preview).getByText('acme@okaxis')).toBeInTheDocument()
    expect(within(preview).getByText('₹10,000.00')).toBeInTheDocument()
    expect(within(preview).queryByRole('link')).not.toBeInTheDocument() // no pay links
    expect(within(preview).queryByRole('button')).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.request.method !== 'GET')).toHaveLength(0) // read-only
  })

  it('hides a method that is switched off', async () => {
    await open(settings({ upi_id: 'acme@okaxis', upi_enabled: false }))
    const preview = screen.getByRole('region', { name: 'How this will look to customers' })
    expect(within(preview).queryByText('acme@okaxis')).not.toBeInTheDocument()
    expect(
      within(preview).getByText('Turn on a payment method to see it here.'),
    ).toBeInTheDocument()
  })

  it('shows bank details only when enabled and complete', async () => {
    await open(
      settings({
        bank_name: 'HDFC Bank',
        account_name: 'Acme Traders Pvt Ltd',
        account_number: '50100234567890',
        ifsc: 'HDFC0001234',
        bank_enabled: true,
      }),
    )
    const preview = screen.getByRole('region', { name: 'How this will look to customers' })
    expect(within(preview).getByText('50100234567890')).toBeInTheDocument()
    expect(within(preview).getByText('HDFC0001234')).toBeInTheDocument()
  })
})

describe('QR code', () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'qr.png', { type: 'image/png' })
  const fileInput = () => screen.getByLabelText('QR code image file') as HTMLInputElement

  it('rejects the wrong type, oversize and tiny images before upload', async () => {
    const { api } = await open()
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(fileInput(), new File(['x'], 'doc.pdf', { type: 'application/pdf' }))
    expect(await screen.findByText(/Upload a PNG or JPG/)).toBeInTheDocument()

    await user.upload(
      fileInput(),
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
    )
    expect(await screen.findByText('This image is larger than 2 MB.')).toBeInTheDocument()

    readImageSize.mockResolvedValueOnce({ width: 200, height: 200 })
    await user.upload(fileInput(), png())
    expect(await screen.findByText(/too small/)).toBeInTheDocument()
    expect(api.calls.filter((c) => c.request.method !== 'GET')).toHaveLength(0)
  })

  it('uploads the image first, then saves the settings, after password confirmation', async () => {
    const after = settings({ has_qr: true, qr_enabled: true })
    const { api } = await open(settings(), {
      [`PUT ${URL_}/qr`]: () => json(settings({ has_qr: true })),
      [`PUT ${URL_}`]: () => json(after),
    })
    await userEvent.upload(fileInput(), png())
    await userEvent.click(screen.getByRole('switch', { name: 'Show QR code to customers' }))
    await save()
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    expect(api.called(`PUT ${URL_}/qr`)).toHaveLength(0) // nothing uploaded before confirmation
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    expect(await screen.findByText('Payment details saved')).toBeInTheDocument()

    const order = api.calls.filter((c) => c.request.method === 'PUT').map((c) => c.key)
    expect(order).toEqual([`PUT ${URL_}/qr`, `PUT ${URL_}`])
    const form = api.called(`PUT ${URL_}/qr`)[0]!.body as FormData
    const sent = form.get('file') as Blob
    expect(sent.size).toBe(4)
    expect(sent.type).toBe('image/png')
  })

  it('cannot turn the QR method on without an image', async () => {
    const { api } = await open()
    await userEvent.click(screen.getByRole('switch', { name: 'Show QR code to customers' }))
    await save()
    expect(await screen.findByText('Upload a QR code before turning this on')).toBeInTheDocument()
    expect(api.called(`PUT ${URL_}`)).toHaveLength(0)
  })

  it('removes a stored image after the settings are saved (QR switched off first)', async () => {
    const { api } = await open(settings({ has_qr: true, qr_enabled: true }), {
      [`PUT ${URL_}`]: () => json(settings({ has_qr: true, qr_enabled: false })),
      [`DELETE ${URL_}/qr`]: () => json(settings({ has_qr: false })),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(screen.getByText('The QR code will be removed when you save.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Show QR code to customers' }))
    await save()
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" })
    await userEvent.type(within(dialog).getByLabelText(/^password/i), 'correct-horse-battery')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and save' }))
    expect(await screen.findByText('Payment details saved')).toBeInTheDocument()
    const order = api.calls
      .filter((c) => ['PUT', 'DELETE'].includes(c.request.method))
      .map((c) => c.key)
    expect(order).toEqual([`PUT ${URL_}`, `DELETE ${URL_}/qr`])
  })

  it('shows the stored QR through an authenticated fetch (blob URL), never a storage link', async () => {
    const { api } = await open(settings({ has_qr: true, qr_enabled: true }))
    const img = await screen.findByAltText('Current QR code')
    expect(img).toHaveAttribute('src', 'blob:mock')
    const qrCall = api.called(`GET ${URL_}/qr`)[0]!
    expect(qrCall.request.headers.get('authorization')).toBe('Bearer test-access-token')
  })
})

describe('unsaved changes', () => {
  it('asks before leaving a dirty form, and Stay keeps the user here', async () => {
    const { router } = await open()
    await userEvent.type(box('UPI ID'), 'acme@okaxis')
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/settings/payment')
    expect(box('UPI ID')).toHaveValue('acme@okaxis')
  })

  it('does not interrupt navigation when nothing changed', async () => {
    const { router } = await open()
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/collections'))
  })
})
