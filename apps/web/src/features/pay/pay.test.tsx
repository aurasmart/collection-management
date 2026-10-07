import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const TOKEN = 'FAKE-test-token-0001' // not a secret: test fixture
const KEY = `GET /api/v1/public/pay/${TOKEN}`
const full = {
  state: 'PENDING',
  company_name: 'Acme Traders',
  customer_name: 'Rahul Sharma',
  amount_due: '15000.00',
  reference: 'INV-1001',
  upi_id: 'acme@okaxis',
  upi_number: '9876543210',
  has_qr: true,
  bank: {
    bank_name: 'HDFC Bank',
    account_name: 'Acme Traders Pvt Ltd',
    account_number: '50100234567890',
    ifsc: 'HDFC0001234',
  },
}

beforeEach(() => {
  fake.reset() // visitors are NOT signed in
})

function open(routes: Parameters<typeof mockApi>[0]) {
  const api = mockApi(routes)
  renderApp(`/pay/${TOKEN}`)
  return api
}

describe('customer payment page', () => {
  it('shows company, customer, amount, reference, UPI, QR, bank details and the plain message', async () => {
    const api = open({ [KEY]: () => json(full) })
    expect(await screen.findByText('Acme Traders')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '₹15,000.00' })).toBeInTheDocument()
    expect(screen.getByText('Rahul Sharma')).toBeInTheDocument()
    expect(screen.getByText('INV-1001')).toBeInTheDocument()
    expect(screen.getByText('acme@okaxis')).toBeInTheDocument()
    expect(screen.getByText('9876543210')).toBeInTheDocument()
    const bank = screen.getByRole('region', { name: 'Bank transfer' })
    for (const t of ['HDFC Bank', 'Acme Traders Pvt Ltd', '50100234567890', 'HDFC0001234']) {
      expect(within(bank).getByText(t)).toBeInTheDocument()
    }
    expect(
      screen.getByText(
        /Payment is made directly to the company\. This page does not process or collect payment\./,
      ),
    ).toBeInTheDocument()
    expect(api.called(KEY)[0]!.request.headers.get('authorization')).toBeNull() // no sign-in needed
  })

  it('shows the company QR image straight from the public endpoint, unchanged and with no amount', async () => {
    open({ [KEY]: () => json(full) })
    const img = (await screen.findByAltText('Acme Traders payment QR code')) as HTMLImageElement
    expect(img.getAttribute('src')).toBe(`http://localhost:8000/api/v1/public/pay/${TOKEN}/qr`)
    expect(img.getAttribute('src')).not.toMatch(/amount|15000|rahul/i)
    expect(
      screen.getByText(/Scan with any UPI app and enter the amount shown above/),
    ).toBeInTheDocument()
  })

  it('does not offer anything that would imply the page takes payment', async () => {
    open({ [KEY]: () => json(full) })
    await screen.findByText('Acme Traders')
    expect(screen.queryByText(/i['’]ve paid|pay now|upi:\/\//i)).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('upi://')
  })

  it('copies the UPI ID', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    open({ [KEY]: () => json(full) })
    await userEvent.click(await screen.findByRole('button', { name: 'Copy UPI ID' }))
    expect(writeText).toHaveBeenCalledWith('acme@okaxis')
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('only shows the methods the company turned on', async () => {
    open({ [KEY]: () => json({ ...full, upi_number: null, has_qr: false, bank: null }) })
    await screen.findByText('acme@okaxis')
    expect(screen.queryByRole('region', { name: 'Bank transfer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'QR code' })).not.toBeInTheDocument()
    expect(screen.queryByText('Copy UPI number')).not.toBeInTheDocument()
  })

  it('says so when the company has not added payment details', async () => {
    open({
      [KEY]: () => json({ ...full, upi_id: null, upi_number: null, has_qr: false, bank: null }),
    })
    expect(await screen.findByText(/hasn't added payment details yet/)).toBeInTheDocument()
  })

  it('a paid customer sees "Payment received" and no payment instructions', async () => {
    open({
      [KEY]: () =>
        json({
          state: 'PAID',
          company_name: 'Acme Traders',
          customer_name: 'Rahul Sharma',
          amount_due: null,
          reference: null,
          upi_id: null,
          upi_number: null,
          has_qr: false,
          bank: null,
        }),
    })
    expect(await screen.findByRole('heading', { name: 'Payment received' })).toBeInTheDocument()
    expect(screen.queryByText('acme@okaxis')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'UPI' })).not.toBeInTheDocument()
  })

  it('an invalid link says so without revealing anything', async () => {
    open({ [KEY]: () => json({ detail: "This link isn't valid." }, 404) })
    expect(
      await screen.findByRole('heading', { name: 'This payment page is unavailable.' }),
    ).toBeInTheDocument()
  })

  it('asks the visitor to wait when rate limited', async () => {
    open({ [KEY]: () => json({ detail: 'slow down' }, 429) })
    expect(await screen.findByText('Please wait a moment')).toBeInTheDocument()
  })

  it('shows a retry when the server is down', async () => {
    let fail = true
    open({ [KEY]: () => (fail ? json({}, 500) : json(full)) })
    expect(await screen.findByText("We can't load this page right now")).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Acme Traders')).toBeInTheDocument()
  })

  it('titles the browser tab with the company name', async () => {
    open({ [KEY]: () => json(full) })
    await screen.findByText('Acme Traders')
    expect(document.title).toBe('Payment request — Acme Traders')
  })
})
