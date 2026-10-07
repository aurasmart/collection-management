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
const row = (n: number, over: Record<string, unknown> = {}) => ({
  row_number: n,
  customer_name: `Customer ${n}`,
  phone: '+919876543210',
  amount_due: '1000.00',
  reference: `INV-${n}`,
  due_date: '2026-10-15',
  errors: [],
  ...over,
})
const bad = row(3, {
  customer_name: '',
  phone: '123',
  errors: [
    { field: 'customer_name', message: 'Enter the customer name' },
    { field: 'phone', message: 'Enter a 10-digit Indian mobile number' },
  ],
})
const ALLOWED = ['row_number', 'customer_name', 'phone', 'amount_due', 'reference', 'due_date']
/** Like the real API (extra="forbid"): any field outside the editable ones is a 422. */
const strict = (rows: Array<Record<string, unknown>>) =>
  rows.every((r) => Object.keys(r).every((k) => ALLOWED.includes(k)))

const preview = (rows: unknown[]) => ({
  filename: 'dues.xlsx',
  rows,
  total: rows.length,
  valid: rows.filter((r) => (r as { errors: unknown[] }).errors.length === 0).length,
  invalid: rows.filter((r) => (r as { errors: unknown[] }).errors.length > 0).length,
})

async function openUpload(routes: Parameters<typeof mockApi>[0]) {
  fake.setSession('o@acme.test')
  const api = mockApi({ 'GET /api/v1/me': () => json(ME), ...routes })
  renderApp('/upload')
  await screen.findByRole('heading', { name: 'Upload customers' })
  return api
}

const file = (name = 'dues.xlsx') => new File(['x'], name)
async function choose(f: File) {
  await userEvent.upload(screen.getByLabelText(/Customer file/), f, { applyAccept: false } as never)
}

beforeEach(() => fake.reset())

describe('upload', () => {
  it('only accepts .xlsx and .csv (PDF, Word and old .xls are refused before upload)', async () => {
    const api = await openUpload({})
    const user = userEvent.setup({ applyAccept: false })
    for (const name of ['a.pdf', 'a.docx', 'a.xls', 'a.txt']) {
      await user.upload(screen.getByLabelText(/Customer file/), file(name))
      expect(
        await screen.findByText(/We can read Excel \(\.xlsx\) and CSV files/),
      ).toBeInTheDocument()
    }
    expect(api.called('POST /api/v1/imports/preview')).toHaveLength(0)
  })

  it('refuses files over 5 MB', async () => {
    await openUpload({})
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(
      screen.getByLabelText(/Customer file/),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.csv'),
    )
    expect(
      await screen.findByText('This file is larger than 5 MB. Split it and upload in parts.'),
    ).toBeInTheDocument()
  })

  it('shows the server message when a file cannot be read', async () => {
    await openUpload({
      'POST /api/v1/imports/preview': () =>
        json({ detail: "We couldn't find the Customer Name and Amount Due columns." }, 422),
    })
    await choose(file())
    expect(
      await screen.findByText(/couldn't find the Customer Name and Amount Due/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Customer file/)).toBeInTheDocument() // still on the first step
  })

  it('offers a sample file and says nothing is saved yet', async () => {
    await openUpload({})
    expect(screen.getByRole('link', { name: 'Download a sample CSV' })).toHaveAttribute(
      'href',
      expect.stringContaining('sample-customers.csv'),
    )
    expect(screen.getByText(/check every row before anything is saved/)).toBeInTheDocument()
  })
})

describe('review and confirm', () => {
  it('shows every customer, flags the broken rows and blocks the import until fixed', async () => {
    const api = await openUpload({
      'POST /api/v1/imports/preview': () => json(preview([row(2), bad])),
    })
    await choose(file())
    expect(await screen.findByText('dues.xlsx')).toBeInTheDocument()
    expect(screen.getByText('2 customers found · 1 need fixing')).toBeInTheDocument()
    expect(screen.getByText('Enter the customer name')).toBeInTheDocument()
    expect(screen.getByText('Enter a 10-digit Indian mobile number')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 customers' })).toBeDisabled()
    expect(api.called('POST /api/v1/imports/confirm')).toHaveLength(0)
    expect(
      within(screen.getByRole('list', { name: 'Customers to import' })).getAllByRole('listitem'),
    ).toHaveLength(2)
    expect(screen.getByLabelText('Due date, row 1')).toHaveValue('15/10/2026')
  })

  it('re-checks an edited row on the server and enables the import when it is fixed', async () => {
    const fixed = row(3, { customer_name: 'Rahul', phone: '+919876543210' })
    const api = await openUpload({
      'POST /api/v1/imports/preview': () => json(preview([row(2), bad])),
      'POST /api/v1/imports/validate': async (req) => {
        const { rows } = (await req.clone().json()) as { rows: Array<Record<string, unknown>> }
        return strict(rows) ? json([fixed]) : json({ detail: 'extra fields not permitted' }, 422)
      },
    })
    await choose(file())
    const name = await screen.findByLabelText('Customer, row 2')
    await userEvent.type(name, 'Rahul')
    await userEvent.tab()
    await waitFor(() => expect(api.called('POST /api/v1/imports/validate')).toHaveLength(1))
    const sent = (
      api.called('POST /api/v1/imports/validate')[0]!.body as {
        rows: Array<Record<string, unknown>>
      }
    ).rows[0]!
    expect(sent.customer_name).toBe('Rahul')
    expect(sent.row_number).toBe(3)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import 2 customers' })).toBeEnabled(),
    )
    expect(screen.getByText('2 customers found · all ready')).toBeInTheDocument()
  })

  it('lets the employer remove a row', async () => {
    await openUpload({ 'POST /api/v1/imports/preview': () => json(preview([row(2), bad])) })
    await choose(file())
    await userEvent.click(await screen.findByRole('button', { name: 'Remove row 2' }))
    expect(screen.getByText('1 customer found · all ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 1 customer' })).toBeEnabled()
  })

  it('imports, then shows how many customers were added', async () => {
    const api = await openUpload({
      'POST /api/v1/imports/preview': () => json(preview([row(2), row(3)])),
      'POST /api/v1/imports/validate': () => json([row(2), row(3)]),
      'POST /api/v1/imports/confirm': async (req) => {
        const body = (await req.clone().json()) as { rows: Array<Record<string, unknown>> }
        return strict(body.rows)
          ? json({ imported: 2 })
          : json({ detail: 'extra fields not permitted' }, 422)
      },
    })
    await choose(file())
    await userEvent.click(await screen.findByRole('button', { name: 'Import 2 customers' }))
    expect(await screen.findByText('2 customers imported')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View collections' })).toHaveAttribute(
      'href',
      expect.stringContaining('/collections'),
    )
    const body = api.called('POST /api/v1/imports/confirm')[0]!.body as {
      filename: string
      rows: unknown[]
    }
    expect(body.filename).toBe('dues.xlsx')
    expect(body.rows).toHaveLength(2)
    expect(JSON.stringify(body)).not.toMatch(/employer/i)
  })

  it('keeps the rows and explains when the import fails', async () => {
    await openUpload({
      'POST /api/v1/imports/preview': () => json(preview([row(2)])),
      'POST /api/v1/imports/validate': () => json([row(2)]),
      'POST /api/v1/imports/confirm': () =>
        json({ detail: 'Some rows still need fixing before they can be imported.' }, 422),
    })
    await choose(file())
    await userEvent.click(await screen.findByRole('button', { name: 'Import 1 customer' }))
    expect(
      await screen.findByText('Some rows still need fixing before they can be imported.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Customer, row 1')).toBeInTheDocument()
  })

  it('checks everything again at the moment of import and does not save if a row is now invalid', async () => {
    const api = await openUpload({
      'POST /api/v1/imports/preview': () => json(preview([row(2)])),
      'POST /api/v1/imports/validate': () => json([{ ...bad, row_number: 2 }]),
    })
    await choose(file())
    await userEvent.click(await screen.findByRole('button', { name: 'Import 1 customer' }))
    expect(await screen.findByText('Enter the customer name')).toBeInTheDocument()
    expect(api.called('POST /api/v1/imports/confirm')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Import 1 customer' })).toBeDisabled()
  })

  it('asks before leaving a review that has not been imported, and Stay keeps the rows', async () => {
    await openUpload({ 'POST /api/v1/imports/preview': () => json(preview([row(2)])) })
    await choose(file())
    await screen.findByText('1 customer found · all ready')
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without importing?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Customer, row 1')).toBeInTheDocument()
  })

  it('does not interrupt leaving before anything was uploaded', async () => {
    await openUpload({})
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    expect(await screen.findByRole('heading', { name: 'Collections' })).toBeInTheDocument()
  })
})
