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
  read_problem: null,
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
          read_problem: 'Text recognition is switched off',
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

  it('reads several receipts at once and reviews and saves them one by one', async () => {
    let n = 0
    const api = open({
      'GET /api/v1/petty-cash': () => json({ items: [], total: 0, total_amount: '0.00' }),
      'POST /api/v1/petty-cash/extract': () =>
        json(n++ === 0 ? proposal : { ...proposal, transaction_id: 'T2', payment_to: 'SIMA BAI' }),
      'POST /api/v1/petty-cash': () => json(entry(), 201),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Add from receipt' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.upload(within(dialog).getByLabelText('Choose receipt'), [
      new File(['x'], 'a.png', { type: 'image/png' }),
      new File(['y'], 'b.png', { type: 'image/png' }),
    ])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Read 2 receipts' }))

    expect(await within(dialog).findByText(/Receipt 1 of 2/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Transaction ID')).toHaveValue('2559007396')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and next' }))

    expect(await within(dialog).findByText(/Receipt 2 of 2/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Payment to')).toHaveValue('SIMA BAI')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save entry' }))

    await waitFor(() => expect(api.called('POST /api/v1/petty-cash')).toHaveLength(2))
    expect(await screen.findByText('2 petty cash entries added')).toBeInTheDocument()
  })

  it('exports the list to Excel using the current search', async () => {
    const created = vi.fn(() => 'blob:x')
    URL.createObjectURL = created
    URL.revokeObjectURL = vi.fn()
    const api = open({
      'GET /api/v1/petty-cash': () =>
        json({ items: [entry()], total: 1, total_amount: '162840.00' }),
      'GET /api/v1/petty-cash/export': () =>
        new Response('xlsx', {
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        }),
    })
    await userEvent.type(await screen.findByLabelText('Search'), 'optima')
    await userEvent.click(await screen.findByRole('button', { name: 'Export to Excel' }))
    await waitFor(() => expect(api.called('GET /api/v1/petty-cash/export')).toHaveLength(1))
    expect(api.called('GET /api/v1/petty-cash/export')[0]!.request.url).toContain('q=optima')
    await waitFor(() => expect(created).toHaveBeenCalled())
  })

  it('sorts and filters by date and amount through the server', async () => {
    const api = open({
      'GET /api/v1/petty-cash': () =>
        json({ items: [entry()], total: 1, total_amount: '162840.00' }),
    })
    await userEvent.selectOptions(await screen.findByLabelText('Sort by'), 'amount_desc')
    await waitFor(() =>
      expect(api.called('GET /api/v1/petty-cash').at(-1)!.request.url).toContain(
        'sort=amount_desc',
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    await userEvent.type(screen.getByLabelText('Amount from (₹)'), '500')
    await userEvent.type(screen.getByLabelText('Date from'), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => {
      const url = api.called('GET /api/v1/petty-cash').at(-1)!.request.url
      expect(url).toContain('min_amount=500')
      expect(url).toContain('date_from=2026-10-01')
      expect(url).toContain('sort=amount_desc')
    })
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Filters (2)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() =>
      expect(api.called('GET /api/v1/petty-cash').at(-1)!.request.url).not.toContain('min_amount'),
    )
  })

  it('selects several entries and deletes them together', async () => {
    let items = [
      entry({ id: 'p1', transaction_id: 'T1' }),
      entry({ id: 'p2', transaction_id: 'T2' }),
      entry({ id: 'p3', transaction_id: 'T3' }),
    ]
    const api = open({
      'GET /api/v1/petty-cash': () => json({ items, total: items.length, total_amount: '0.00' }),
      'POST /api/v1/petty-cash/delete': () => {
        items = items.filter((e) => e.id === 'p3')
        return json({ deleted: 2 })
      },
    })
    await userEvent.click(await screen.findByLabelText('Select T1'))
    await userEvent.click(screen.getByLabelText('Select T2'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete 2 entries' }),
    )
    await waitFor(() => expect(api.called('POST /api/v1/petty-cash/delete')).toHaveLength(1))
    expect(api.called('POST /api/v1/petty-cash/delete')[0]!.body).toEqual({ ids: ['p1', 'p2'] })
    expect(await screen.findByText('2 entries deleted')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByLabelText('Select T1')).not.toBeInTheDocument())
  })

  it('selects every entry on the page at once', async () => {
    open({
      'GET /api/v1/petty-cash': () =>
        json({
          items: [
            entry({ id: 'p1', transaction_id: 'T1' }),
            entry({ id: 'p2', transaction_id: 'T2' }),
          ],
          total: 2,
          total_amount: '0.00',
        }),
    })
    await userEvent.click(await screen.findByLabelText('Select all on this page'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Select all on this page'))
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument()
  })
})
