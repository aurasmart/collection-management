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
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  transaction_id: '2559007396',
  txn_date: '2026-10-06',
  payment_to: 'optimaprojectors',
  payment_from: 'LATIGID ENGINEERING PRIVATE LIMITED',
  remarks: 'amruppaporter',
  amount: '162840.00',
  content_type: 'image/png',
  original_name: 'r.png',
  created_at: '2026-10-06T16:17:00Z',
  ...over,
})
const proposal = {
  transaction_id: '2559007396',
  txn_date: '2026-10-06',
  payment_to: 'optimaprojectors',
  payment_from: 'LATIGID ENGINEERING PRIVATE LIMITED',
  remarks: 'amruppaporter',
  amount: '162840.00',
  found: ['transaction_id', 'txn_date', 'payment_to', 'payment_from', 'remarks', 'amount'],
  text_read: true,
  duplicate: false,
}

function open(routes: Parameters<typeof mockApi>[0]) {
  fake.setSession('o@acme.test')
  const api = mockApi({
    'GET /api/v1/me': () => json(ME),
    'GET /api/v1/settings/company': () => json({ display_name: 'Acme', recent_changes: [] }),
    ...routes,
  })
  renderApp('/petty-cash')
  return api
}

beforeEach(() => fake.reset())

describe('Petty Cash', () => {
  it('sits between Collections and Import in the navigation', async () => {
    open({ 'GET /api/v1/petty-cash': () => json({ items: [], total: 0, total_amount: '0.00' }) })
    await screen.findByRole('heading', { name: 'Petty Cash' })
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Dashboard', 'Collections', 'Petty Cash', 'Import', 'Settings'])
  })

  it('shows an empty state with an action', async () => {
    open({ 'GET /api/v1/petty-cash': () => json({ items: [], total: 0, total_amount: '0.00' }) })
    expect(await screen.findByText('No petty cash entries yet')).toBeInTheDocument()
  })

  it('lists saved entries with the six fields and Indian-grouped rupees', async () => {
    open({
      'GET /api/v1/petty-cash': () =>
        json({ items: [entry()], total: 1, total_amount: '162840.00' }),
    })
    const table = await screen.findByRole('table')
    expect(within(table).getByText('optimaprojectors')).toBeInTheDocument()
    expect(within(table).getByText('2559007396')).toBeInTheDocument()
    expect(within(table).getByText('amruppaporter')).toBeInTheDocument()
    expect(within(table).getByText('06 Oct 2026')).toBeInTheDocument()
    expect(within(table).getByText('₹1,62,840.00')).toBeInTheDocument()
  })

  it('reads a receipt, lets the user correct the values, then saves', async () => {
    let saved = false
    const api = open({
      'GET /api/v1/petty-cash': () =>
        saved
          ? json({ items: [entry()], total: 1, total_amount: '162840.00' })
          : json({ items: [], total: 0, total_amount: '0.00' }),
      'POST /api/v1/petty-cash/extract': () => json(proposal),
      'POST /api/v1/petty-cash': () => {
        saved = true
        return json(entry(), 201)
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Add from receipt' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Read receipt' })).toBeDisabled()
    await userEvent.upload(
      within(dialog).getByLabelText('Choose receipt'),
      new File(['x'], 'r.png', { type: 'image/png' }),
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Read receipt' }))

    expect(await within(dialog).findByLabelText('Transaction ID')).toHaveValue('2559007396')
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-10-06')
    expect(within(dialog).getByLabelText('Payment to')).toHaveValue('optimaprojectors')
    expect(within(dialog).getByLabelText('Payment from')).toHaveValue(
      'LATIGID ENGINEERING PRIVATE LIMITED',
    )
    expect(within(dialog).getByLabelText('Remarks')).toHaveValue('amruppaporter')
    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue('162840.00')
    expect(api.called('POST /api/v1/petty-cash')).toHaveLength(0) // nothing saved yet

    await userEvent.clear(within(dialog).getByLabelText('Remarks'))
    await userEvent.type(within(dialog).getByLabelText('Remarks'), 'Porter charges')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(api.called('POST /api/v1/petty-cash')).toHaveLength(1))
    const form = api.called('POST /api/v1/petty-cash')[0]!.body as FormData
    expect(JSON.parse(form.get('fields') as string)).toMatchObject({
      transaction_id: '2559007396',
      remarks: 'Porter charges',
      amount: '162840.00',
    })
    expect((form.get('file') as File).size).toBe(1)
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('warns when the receipt could not be read and lets the user type the values', async () => {
    open({
      'GET /api/v1/petty-cash': () => json({ items: [], total: 0, total_amount: '0.00' }),
      'POST /api/v1/petty-cash/extract': () =>
        json({
          transaction_id: null,
          txn_date: null,
          payment_to: null,
          payment_from: null,
          remarks: null,
          amount: null,
          found: [],
          text_read: false,
          duplicate: false,
        }),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Add from receipt' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.upload(
      within(dialog).getByLabelText('Choose receipt'),
      new File(['x'], 'r.pdf', { type: 'application/pdf' }),
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Read receipt' }))
    expect(await within(dialog).findByText("We couldn't read this receipt")).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue('')
  })

  it('flags a possible duplicate and shows server validation under the field', async () => {
    open({
      'GET /api/v1/petty-cash': () => json({ items: [], total: 0, total_amount: '0.00' }),
      'POST /api/v1/petty-cash/extract': () => json({ ...proposal, duplicate: true, amount: null }),
      'POST /api/v1/petty-cash': () =>
        json(
          { detail: [{ loc: ['body', 'amount'], msg: 'Amount must be more than 0', type: 'v' }] },
          422,
        ),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Add from receipt' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.upload(
      within(dialog).getByLabelText('Choose receipt'),
      new File(['x'], 'r.png', { type: 'image/png' }),
    )
    await userEvent.click(within(dialog).getByRole('button', { name: 'Read receipt' }))
    expect(await within(dialog).findByText('Possible duplicate')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))
    expect(await within(dialog).findByText('Amount must be more than 0')).toBeInTheDocument()
  })

  it('deletes an entry after confirming', async () => {
    let items = [entry()]
    const api = open({
      'GET /api/v1/petty-cash': () => json({ items, total: items.length, total_amount: '0.00' }),
      'DELETE /api/v1/petty-cash/p1': () => {
        items = []
        return new Response(null, { status: 204 })
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Delete 2559007396' }))
    expect(api.called('DELETE /api/v1/petty-cash/p1')).toHaveLength(0)
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete entry' }),
    )
    await waitFor(() => expect(api.called('DELETE /api/v1/petty-cash/p1')).toHaveLength(1))
    expect(await screen.findByText('No petty cash entries yet')).toBeInTheDocument()
  })
})
