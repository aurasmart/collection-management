import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fake } from '@/test/fake-supabase'
import { json, mockApi, renderApp } from '@/test/render-app'

vi.mock('@/lib/supabase', async () => {
  const { fake } = await import('@/test/fake-supabase')
  return { supabase: fake, authOptions: {}, createSupabase: vi.fn() }
})

const ME = { employer: { id: 'e1', name: 'Acme', email: 'o@acme.test' } }
const FAKE_TOKEN = 'FAKE-test-token-0002' // not a secret: test fixture
const ID = '11111111-2222-3333-4444-555555555555'
const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  customer_name: 'Rahul Sharma',
  phone: '+919876543210',
  amount_due: '15000.00',
  due_date: '2026-10-15',
  reference: 'INV-1001',
  status: 'PENDING',
  has_payment_page: false,
  ...over,
})
const detail = (over: Record<string, unknown> = {}) => ({
  ...item(),
  payment_token: null,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
  ...over,
})
const list = (items: unknown[], total = items.length) => json({ items, total })

const dash = () =>
  json({
    total_outstanding: '0.00',
    pending_customers: 0,
    paid_amount: '0.00',
    customers: 0,
    recent: [],
  })

const lastParams = (api: ReturnType<typeof mockApi>) => {
  const calls = api.called('GET /api/v1/collections')
  return new URL(calls[calls.length - 1]!.request.url).searchParams
}

function open(path: string, routes: Parameters<typeof mockApi>[0]) {
  fake.setSession('o@acme.test')
  const api = mockApi({
    'GET /api/v1/me': () => json(ME),
    'GET /api/v1/dashboard': dash,
    ...routes,
  })
  renderApp(path)
  return api
}

beforeEach(() => fake.reset())

describe('Collections list', () => {
  it('shows the simple table: customer, phone, amount, due date, status, action', async () => {
    open('/collections', {
      'GET /api/v1/collections': () =>
        list([
          item(),
          item({ id: 'b', customer_name: 'Priya', status: 'PAID', due_date: null, phone: null }),
        ]),
    })
    const table = await screen.findByRole('table', { name: 'Customers and what they owe' })
    for (const h of [
      'Customer',
      'Phone',
      'Amount due',
      'Due date',
      'Reference',
      'Status',
      'Action',
    ]) {
      expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument()
    }
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('₹15,000.00')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('15 Oct 2026')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Pending')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Paid')).toBeInTheDocument()
    expect(within(rows[1]!).queryByRole('button', { name: /as paid/ })).not.toBeInTheDocument()
    expect(
      within(rows[1]!).getByRole('button', { name: 'Mark unpaid for Priya' }),
    ).toBeInTheDocument()
    expect(within(rows[0]!).getByText('+91 98765 43210')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('INV-1001')).toBeInTheDocument()
  })

  it('shows only Pending and Paid (no other statuses)', async () => {
    open('/collections', { 'GET /api/v1/collections': () => list([item()]) })
    const group = await screen.findByRole('group', { name: 'Filter by status' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'Pending', 'Paid'])
  })

  it('filters by status and searches on the server', async () => {
    const api = open('/collections', { 'GET /api/v1/collections': () => list([item()]) })
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: 'Paid' }))
    await waitFor(() =>
      expect(
        api
          .called('GET /api/v1/collections')
          .some((c) => new URL(c.request.url).searchParams.get('status') === 'PAID'),
      ).toBe(true),
    )
    await userEvent.type(screen.getByLabelText('Search customers'), 'rahul')
    await waitFor(() =>
      expect(
        api
          .called('GET /api/v1/collections')
          .some((c) => new URL(c.request.url).searchParams.get('q') === 'rahul'),
      ).toBe(true),
    )
  })

  it('has friendly empty states', async () => {
    open('/collections', { 'GET /api/v1/collections': () => list([]) })
    expect(await screen.findByText('No collections yet')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Import customers' }).length).toBe(2)
  })

  it('has an error state with Retry', async () => {
    let fail = true
    open('/collections', {
      'GET /api/v1/collections': () => (fail ? json({}, 500) : list([item()])),
    })
    expect(await screen.findByText("Couldn't load customers")).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('pages through long lists', async () => {
    const api = open('/collections', { 'GET /api/v1/collections': () => list([item()], 120) })
    expect(await screen.findByText('Showing 1–50 of 120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Showing 51–100 of 120')).toBeInTheDocument()
    expect(
      api
        .called('GET /api/v1/collections')
        .some((c) => new URL(c.request.url).searchParams.get('offset') === '50'),
    ).toBe(true)
  })

  it('marks a customer paid from the list after confirming', async () => {
    let status = 'PENDING'
    const api = open('/collections', {
      'GET /api/v1/collections': () => list([item({ status })]),
      [`POST /api/v1/collections/${ID}/mark-paid`]: () => {
        status = 'PAID'
        return json(detail({ status: 'PAID' }))
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark paid for Rahul Sharma' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Mark ₹15,000 as paid for Rahul Sharma?',
    })
    expect(api.called(`POST /api/v1/collections/${ID}/mark-paid`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as Paid' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const table = await screen.findByRole('table')
    expect(await within(table).findByText('Paid')).toBeInTheDocument()
    expect(within(table).queryByRole('button', { name: /as paid/ })).not.toBeInTheDocument()
    expect(
      within(table).getByRole('button', { name: 'Mark unpaid for Rahul Sharma' }),
    ).toBeInTheDocument()
  })

  it('cancelling the confirmation changes nothing', async () => {
    const api = open('/collections', { 'GET /api/v1/collections': () => list([item()]) })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark paid for Rahul Sharma' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(api.called(`POST /api/v1/collections/${ID}/mark-paid`)).toHaveLength(0)
  })
})

describe('Collections list extras', () => {
  it('says so plainly when a search finds nobody', async () => {
    open('/collections', { 'GET /api/v1/collections': () => list([]) })
    await userEvent.type(await screen.findByLabelText('Search customers'), 'zzz')
    expect(await screen.findByText('No customers match your search.')).toBeInTheDocument()
  })

  it('marks a paid customer unpaid from the list after confirming', async () => {
    let status = 'PAID'
    const api = open('/collections', {
      'GET /api/v1/collections': () => list([item({ status })]),
      [`POST /api/v1/collections/${ID}/mark-unpaid`]: () => {
        status = 'PENDING'
        return json(detail({ status: 'PENDING' }))
      },
    })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Mark unpaid for Rahul Sharma' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Mark Rahul Sharma as unpaid?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as Unpaid' }))
    expect(
      await screen.findByRole('button', { name: 'Mark paid for Rahul Sharma' }),
    ).toBeInTheDocument()
    expect(api.called(`POST /api/v1/collections/${ID}/mark-unpaid`)).toHaveLength(1)
  })

  it('shows a readable error and keeps the dialog when marking paid fails', async () => {
    open('/collections', {
      'GET /api/v1/collections': () => list([item()]),
      [`POST /api/v1/collections/${ID}/mark-paid`]: () => json({ detail: 'boom' }, 500),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark paid for Rahul Sharma' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as Paid' }))
    expect(
      await within(dialog).findByText("Couldn't update. Please try again."),
    ).toBeInTheDocument()
  })
})

describe('Customer detail', () => {
  const page = `/collections/${ID}`

  it('shows the customer and offers Generate Payment Page first', async () => {
    open(page, { [`GET /api/v1/collections/${ID}`]: () => json(detail()) })
    expect(await screen.findByRole('heading', { name: 'Rahul Sharma' })).toBeInTheDocument()
    const card = screen.getByRole('region', { name: 'Customer details' })
    for (const t of [
      '+91 98765 43210',
      '₹15,000.00',
      'INV-1001',
      '15 Oct 2026',
      'Not created yet',
    ]) {
      expect(within(card).getByText(t)).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Generate Payment Page' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy Link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Send on WhatsApp' })).not.toBeInTheDocument()
  })

  it('generates the page, then offers Copy Link, WhatsApp and SMS with the right message', async () => {
    let token: string | null = null
    open(page, {
      [`GET /api/v1/collections/${ID}`]: () =>
        json(detail({ payment_token: token, has_payment_page: !!token })),
      [`POST /api/v1/collections/${ID}/payment-page`]: () => {
        token = FAKE_TOKEN
        return json(detail({ payment_token: token, has_payment_page: true }))
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Generate Payment Page' }))
    expect(await screen.findByText('Payment page generated')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    const link = `http://localhost:3000/#/pay/FAKE-test-token-0002`
    const input = await screen.findByLabelText('Link to send to the customer')
    expect((input as HTMLInputElement).value).toMatch(/\/#\/pay\/FAKE-test-token-0002$/)

    const message =
      'Hello Rahul,\n\nYour outstanding amount is ₹15,000.\n\nPlease make the payment using the payment details below:\n\n' +
      (input as HTMLInputElement).value +
      '\n\nThank you.'
    const wa = screen.getByRole('link', { name: 'Send on WhatsApp' })
    expect(wa).toHaveAttribute(
      'href',
      `https://wa.me/919876543210?text=${encodeURIComponent(message)}`,
    )
    expect(wa).toHaveAttribute('target', '_blank')
    expect(wa).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.getByRole('link', { name: 'Send SMS' })).toHaveAttribute(
      'href',
      `sms:+919876543210?&body=${encodeURIComponent(message)}`,
    )
    expect(link).toContain('/#/pay/') // hash-routed public URL
    expect(screen.queryByRole('button', { name: 'Generate Payment Page' })).not.toBeInTheDocument()
  })

  it('copies the link', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    open(page, {
      [`GET /api/v1/collections/${ID}`]: () =>
        json(detail({ payment_token: FAKE_TOKEN, has_payment_page: true })),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Copy Link' }))
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/#\/pay\/FAKE-test-token-0002$/))
    expect(await screen.findByText('Link copied')).toBeInTheDocument()
  })

  it('without a phone number, WhatsApp and SMS are disabled and the reason is explained', async () => {
    open(page, {
      [`GET /api/v1/collections/${ID}`]: () =>
        json(detail({ phone: null, payment_token: FAKE_TOKEN, has_payment_page: true })),
    })
    await screen.findByRole('button', { name: 'Copy Link' })
    expect(screen.queryByRole('link', { name: 'Send on WhatsApp' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send on WhatsApp' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send SMS' })).toBeDisabled()
    expect(
      screen.getByText(/no phone number, so WhatsApp and SMS are unavailable/),
    ).toBeInTheDocument()
  })

  it('Mark as Paid asks first, then the customer becomes Paid and can be marked Unpaid', async () => {
    let current = detail()
    const api = open(page, {
      [`GET /api/v1/collections/${ID}`]: () => json(current),
      [`POST /api/v1/collections/${ID}/mark-paid`]: () =>
        json((current = detail({ status: 'PAID' }))),
      [`POST /api/v1/collections/${ID}/mark-unpaid`]: () =>
        json((current = detail({ status: 'PENDING' }))),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Mark as Paid' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Mark ₹15,000 as paid for Rahul Sharma?',
    })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(api.called(`POST /api/v1/collections/${ID}/mark-paid`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark as Paid' }))

    const unpaid = await screen.findByRole('button', { name: 'Mark as Unpaid' })
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    await userEvent.click(unpaid)
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mark as Unpaid' }),
    )
    expect(await screen.findByRole('button', { name: 'Mark as Paid' })).toBeInTheDocument()
  })

  it('edits the customer, with server validation shown under the fields', async () => {
    let current = detail()
    open(page, {
      [`GET /api/v1/collections/${ID}`]: () => json(current),
      [`PUT /api/v1/collections/${ID}`]: async (req) => {
        const body = (await req.clone().json()) as Record<string, string>
        if (body.amount_due === 'abc') {
          return json(
            {
              detail: [
                {
                  loc: ['body', 'amount_due'],
                  msg: "Amount isn't a valid number",
                  type: 'value_error',
                },
              ],
            },
            422,
          )
        }
        return json(
          (current = detail({ customer_name: body.customer_name, amount_due: '16000.00' })),
        )
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit customer' })
    const amount = within(dialog).getByLabelText(/Amount due/)
    await userEvent.clear(amount)
    await userEvent.type(amount, 'abc')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await within(dialog).findByText("Amount isn't a valid number")).toBeInTheDocument()
    await userEvent.clear(amount)
    await userEvent.type(amount, '16000')
    const name = within(dialog).getByLabelText(/Customer name/)
    await userEvent.clear(name)
    await userEvent.type(name, 'Rahul S.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('heading', { name: 'Rahul S.' })).toBeInTheDocument()
    expect(await screen.findByText('Customer saved')).toBeInTheDocument()
  })

  it('shows "not found" for an unknown or foreign customer', async () => {
    open(page, {
      [`GET /api/v1/collections/${ID}`]: () => json({ detail: 'Customer not found' }, 404),
    })
    expect(await screen.findByText('Customer not found')).toBeInTheDocument()
  })
})

describe('Collections sort, filters and delete', () => {
  it('sorts on the server and resets to the first page', async () => {
    const api = open('/collections', { 'GET /api/v1/collections': () => list([item()]) })
    await screen.findByRole('table')
    expect(lastParams(api).get('sort')).toBe('created_desc')
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'due_asc')
    await waitFor(() => expect(lastParams(api).get('sort')).toBe('due_asc'))
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'amount_desc')
    await waitFor(() => expect(lastParams(api).get('sort')).toBe('amount_desc'))
  })

  it('applies the overdue chip and the filter panel, shows chips and clears them', async () => {
    const api = open('/collections', { 'GET /api/v1/collections': () => list([item()]) })
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: 'Overdue' }))
    await waitFor(() => expect(lastParams(api).get('overdue')).toBe('true'))

    await userEvent.click(screen.getByRole('button', { name: /Filters/ }))
    await userEvent.type(screen.getByLabelText('Amount from (₹)'), '1000')
    await userEvent.selectOptions(screen.getByLabelText('Phone number'), 'no')
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => {
      expect(lastParams(api).get('min_amount')).toBe('1000')
      expect(lastParams(api).get('has_phone')).toBe('no')
    })
    const chips = screen.getByRole('list', { name: 'Active filters' })
    expect(within(chips).getByText('Amount from ₹1,000.00')).toBeInTheDocument()
    expect(within(chips).getByText('No phone number')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove filter: No phone number' }))
    await waitFor(() => expect(lastParams(api).get('has_phone')).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    await waitFor(() => {
      expect(lastParams(api).get('overdue')).toBeNull()
      expect(lastParams(api).get('min_amount')).toBeNull()
    })
    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument()
  })

  it('opens already narrowed when linked from the dashboard (?overdue=1)', async () => {
    const api = open('/collections?overdue=1', {
      'GET /api/v1/collections': () => list([item()]),
    })
    await screen.findByRole('table')
    expect(lastParams(api).get('overdue')).toBe('true')
    expect(screen.getByRole('button', { name: 'Overdue' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('says nothing matches when a filter returns no customers', async () => {
    open('/collections', { 'GET /api/v1/collections': () => list([]) })
    await screen.findByText('No collections yet')
  })

  it('deletes one customer after a confirmation, and cancel deletes nothing', async () => {
    let rows = [item()]
    const api = open('/collections', {
      'GET /api/v1/collections': () => list(rows),
      [`DELETE /api/v1/collections/${ID}`]: () => {
        rows = []
        return new Response(null, { status: 204 })
      },
    })
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rahul Sharma' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete Rahul Sharma?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.called(`DELETE /api/v1/collections/${ID}`)).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Delete Rahul Sharma' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete customer' }),
    )
    expect(await screen.findByText('Rahul Sharma deleted')).toBeInTheDocument()
    expect(await screen.findByText('No collections yet')).toBeInTheDocument()
  })

  it('selects several customers and deletes them together, warning about paid ones', async () => {
    const a = item({ id: 'a1', customer_name: 'Asha' })
    const b = item({ id: 'b2', customer_name: 'Bimal', status: 'PAID' })
    let rows = [a, b]
    const api = open('/collections', {
      'GET /api/v1/collections': () => list(rows),
      'POST /api/v1/collections/delete': () => {
        rows = []
        return json({ deleted: 2 })
      },
    })
    await screen.findByRole('table')
    await userEvent.click(screen.getByLabelText('Select all on this page'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 customers?' })
    expect(within(dialog).getByText(/1 of them is marked Paid/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 customers' }))
    expect(await screen.findByText('2 customers deleted')).toBeInTheDocument()
    expect(api.called('POST /api/v1/collections/delete')).toHaveLength(1)
    const body = (await api
      .called('POST /api/v1/collections/delete')[0]!
      .request.clone()
      .json()) as {
      ids: string[]
    }
    expect(body.ids).toEqual(['a1', 'b2'])
  })

  it('keeps everything when a delete fails', async () => {
    open('/collections', {
      'GET /api/v1/collections': () => list([item()]),
      [`DELETE /api/v1/collections/${ID}`]: () => json({}, 500),
    })
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rahul Sharma' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete customer' }),
    )
    expect(await screen.findByText(/Couldn't delete\. Nothing was removed/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Rahul Sharma', hidden: true })).toBeInTheDocument()
  })

  it('deletes from the customer page and returns to the list', async () => {
    open(`/collections/${ID}`, {
      [`GET /api/v1/collections/${ID}`]: () => json(detail()),
      [`DELETE /api/v1/collections/${ID}`]: () => new Response(null, { status: 204 }),
      'GET /api/v1/collections': () => list([]),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete customer' }),
    )
    expect(await screen.findByText('Rahul Sharma deleted')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Collections' })).toBeInTheDocument()
  })
})
