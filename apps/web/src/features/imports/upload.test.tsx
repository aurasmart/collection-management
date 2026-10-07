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
  warnings: [],
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

const preview = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  filename: 'dues.xlsx',
  source: 'excel',
  ocr: false,
  rows,
  skipped: [],
  notes: [],
  total: rows.length,
  valid: rows.filter((r) => (r as { errors: unknown[] }).errors.length === 0).length,
  invalid: rows.filter((r) => (r as { errors: unknown[] }).errors.length > 0).length,
  ...over,
})

type FieldKey = 'customer_name' | 'phone' | 'amount_due' | 'reference' | 'due_date'
const LABELS: Record<FieldKey, string> = {
  customer_name: 'Customer Name',
  phone: 'Phone Number',
  amount_due: 'Amount Due',
  reference: 'Reference',
  due_date: 'Due Date',
}
const col = (index: number, header: string, over: Record<string, unknown> = {}) => ({
  index,
  header,
  samples: ['Rahul Sharma', 'Priya'],
  suggested: null,
  confidence: 'none',
  alternatives: [],
  date_info: null,
  count: 0,
  total: null,
  ...over,
})

/** A server analysis: `columns` carry the suggestions, `fields` say what was found. */
function analysis(
  over: {
    columns?: ReturnType<typeof col>[]
    status?: Partial<Record<FieldKey, 'detected' | 'uncertain' | 'missing'>>
    map?: Partial<Record<FieldKey, number | null>>
  } & Record<string, unknown> = {},
) {
  const { columns, status = {}, map = {}, ...rest } = over
  const cols = columns ?? [
    col(0, 'Party Name', { suggested: 'customer_name', confidence: 'high' }),
    col(1, 'Mobile No', { suggested: 'phone', confidence: 'high', samples: ['9876543210'] }),
    col(2, 'Outstanding', { suggested: 'amount_due', confidence: 'high', samples: ['15,000'] }),
    col(3, 'Invoice No', { suggested: 'reference', confidence: 'high', samples: ['INV-001'] }),
    col(4, 'Payment Due', {
      suggested: 'due_date',
      confidence: 'high',
      samples: ['15/10/2026'],
      date_info: { ambiguous: false, order: 'dmy', examples: [] },
    }),
    col(5, 'Salesman', { samples: ['Ravi'] }),
  ]
  const fields = (Object.keys(LABELS) as FieldKey[]).map((f) => {
    const c = cols.find((x) => x.suggested === f)
    const column = f in map ? (map[f] ?? null) : (c?.index ?? null)
    return {
      field: f,
      label: LABELS[f],
      required: f === 'customer_name' || f === 'amount_due',
      status: status[f] ?? (column === null ? 'missing' : 'detected'),
      column,
      competing: [] as number[],
    }
  })
  return {
    filename: 'dues.xlsx',
    source: 'excel',
    ocr: false,
    sheets: [{ index: 0, name: 'Sheet1', rows: 8 }],
    sheet: 0,
    header_row: 1,
    table: 0,
    tables: [{ index: 0, title: '', header_rows: [1, 1], first_row: 2, last_row: 4, records: 3 }],
    structure: 'high',
    columns: cols,
    fields,
    data_rows: 3,
    notes: [],
    ...rest,
  }
}

let client: ReturnType<typeof renderApp>['client']
async function openImport(routes: Parameters<typeof mockApi>[0]) {
  fake.setSession('o@acme.test')
  const api = mockApi({ 'GET /api/v1/me': () => json(ME), ...routes })
  client = renderApp('/upload').client
  await screen.findByRole('heading', { name: 'Import customer collections' })
  return api
}

const file = (name = 'dues.xlsx') => new File(['x'], name)
async function choose(f: File) {
  await userEvent.upload(screen.getByLabelText(/Customer file/), f, { applyAccept: false } as never)
}
const form = (api: Awaited<ReturnType<typeof openImport>>, key: string, n = 0) =>
  api.called(key)[n]!.body as FormData
const mappingSent = (fd: FormData) =>
  JSON.parse(String(fd.get('mapping'))) as Record<string, unknown>
const detectedAs = (header: string) =>
  screen.getByRole('combobox', { name: `Detected as, for column ${header}` })

beforeEach(() => fake.reset())

describe('import landing', () => {
  it('replaces the exact-columns instructions with the flexible import wording', async () => {
    await openImport({})
    expect(
      screen.getByText(
        "Upload an Excel, CSV or PDF file, or import from Google Sheets. We'll automatically detect customer names, phone numbers, outstanding amounts, references and dates. You can review and correct the mapping before anything is imported.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/with these columns/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload File' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import from Google Sheets' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download sample template' })).toHaveAttribute(
      'href',
      expect.stringContaining('sample-customers.csv'),
    )
    expect(screen.getByText(/template is optional/)).toBeInTheDocument()
  })

  it('accepts Excel, CSV and PDF; everything else is refused before upload', async () => {
    const api = await openImport({})
    const user = userEvent.setup({ applyAccept: false })
    for (const name of ['a.docx', 'a.txt', 'a.png', 'a.xlsm']) {
      await user.upload(screen.getByLabelText(/Customer file/), file(name))
      expect(
        await screen.findByText(
          'We can read Excel (.xlsx, .xls), CSV and PDF files. Please upload one of those.',
        ),
      ).toBeInTheDocument()
    }
    expect(api.called('POST /api/v1/imports/analyze')).toHaveLength(0)
    expect(screen.getByLabelText(/Customer file/)).toHaveAttribute('accept', '.xlsx,.xls,.csv,.pdf')
  })

  it.each(['a.xlsx', 'a.xls', 'a.csv', 'a.pdf', 'A.XLSX'])(
    'sends %s for analysis',
    async (name) => {
      const api = await openImport({ 'POST /api/v1/imports/analyze': () => json(analysis()) })
      await choose(file(name))
      expect(await screen.findByText('Check how we read your file')).toBeInTheDocument()
      expect(api.called('POST /api/v1/imports/analyze')).toHaveLength(1)
    },
  )

  it('refuses files over 5 MB', async () => {
    await openImport({})
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(
      screen.getByLabelText(/Customer file/),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.csv'),
    )
    expect(
      await screen.findByText('This file is larger than 5 MB. Split it and upload in parts.'),
    ).toBeInTheDocument()
  })

  it('shows the server message and stays on the first step when a file cannot be read', async () => {
    await openImport({
      'POST /api/v1/imports/analyze': () =>
        json({ detail: 'This PDF has 11 pages. The limit is 10 pages.' }, 422),
    })
    await choose(file('big.pdf'))
    expect(await screen.findByText(/The limit is 10 pages/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Customer file/)).toBeInTheDocument()
  })

  it('explains a network failure calmly', async () => {
    await openImport({
      'POST /api/v1/imports/analyze': () => {
        throw new TypeError('network')
      },
    })
    await choose(file())
    expect(
      await screen.findByText("Can't reach the server. Check your connection and try again."),
    ).toBeInTheDocument()
  })
})

describe('Google Sheets source', () => {
  const GOOGLE = 'GET /api/v1/imports/google-sheets'

  it('explains how to import a private sheet when the service account is configured', async () => {
    await openImport({
      [GOOGLE]: () =>
        json({ private_access: true, service_account_email: 'sa@proj.iam.gserviceaccount.com' }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import from Google Sheets' }))
    expect(await screen.findByText('sa@proj.iam.gserviceaccount.com')).toBeInTheDocument()
    expect(
      screen.getByText(/share the sheet with our Google service account as/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Anyone with the link can view/)).toBeInTheDocument()
  })

  it('says private sheets are not set up when there is no service account', async () => {
    await openImport({
      [GOOGLE]: () => json({ private_access: false, service_account_email: null }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import from Google Sheets' }))
    expect(await screen.findByText(/importing private sheets isn't set up yet/)).toBeInTheDocument()
  })

  it('asks for a link, then reads the sheet and shows the mapping', async () => {
    const api = await openImport({
      [GOOGLE]: () => json({ private_access: false, service_account_email: null }),
      'POST /api/v1/imports/analyze': () =>
        json(analysis({ source: 'google_sheets', filename: 'Google Sheet' })),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import from Google Sheets' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Read sheet' }))
    expect(screen.getByText('Paste the link to your Google Sheet.')).toBeInTheDocument()
    expect(api.called('POST /api/v1/imports/analyze')).toHaveLength(0)
    await userEvent.type(
      screen.getByLabelText('Google Sheets link'),
      'https://docs.google.com/spreadsheets/d/abc',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Read sheet' }))
    expect(await screen.findByText('Check how we read your file')).toBeInTheDocument()
    const fd = form(api, 'POST /api/v1/imports/analyze')
    expect(fd.get('sheet_url')).toBe('https://docs.google.com/spreadsheets/d/abc')
    expect(fd.get('file')).toBeNull()
  })

  it("shows Google's message when the sheet can't be opened", async () => {
    await openImport({
      [GOOGLE]: () => json({ private_access: true, service_account_email: 'sa@x.test' }),
      'POST /api/v1/imports/analyze': () =>
        json({ detail: "We couldn't open this sheet. Share it with sa@x.test as Viewer." }, 422),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import from Google Sheets' }))
    await userEvent.type(
      await screen.findByLabelText('Google Sheets link'),
      'https://docs.google.com/x',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Read sheet' }))
    expect(await screen.findByText(/Share it with sa@x.test as Viewer/)).toBeInTheDocument()
  })
})

describe('mapping', () => {
  async function toMapping(over: Parameters<typeof analysis>[0] = {}, extra = {}) {
    const api = await openImport({
      'POST /api/v1/imports/analyze': () => json(analysis(over)),
      'POST /api/v1/imports/preview': () => json(preview([row(2), row(3)])),
      ...extra,
    })
    await choose(file())
    await screen.findByText('Check how we read your file')
    return api
  }

  it("shows each of the employer's columns, sample values and what we detected", async () => {
    await toMapping()
    expect(screen.getByText('Party Name')).toBeInTheDocument()
    expect(detectedAs('Party Name')).toHaveValue('customer_name')
    expect(detectedAs('Mobile No')).toHaveValue('phone')
    expect(detectedAs('Outstanding')).toHaveValue('amount_due')
    expect(detectedAs('Invoice No')).toHaveValue('reference')
    expect(detectedAs('Payment Due')).toHaveValue('due_date')
    expect(detectedAs('Salesman')).toHaveValue('') // ignored
    expect(screen.getAllByText('15,000').length).toBeGreaterThan(0) // example values
    expect(screen.getByText('Ignored')).toBeInTheDocument()
    const summary = screen.getByRole('region', { name: 'What we need' })
    expect(within(summary).getAllByText('Detected')).toHaveLength(5)
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeEnabled()
  })

  it('sends the confirmed mapping to the server and shows the review', async () => {
    const api = await toMapping()
    await userEvent.click(screen.getByRole('button', { name: 'Continue to review' }))
    expect(await screen.findByText('2 customers found · all ready')).toBeInTheDocument()
    const fd = form(api, 'POST /api/v1/imports/preview')
    expect(mappingSent(fd)).toEqual({
      customer_name: 0,
      phone: 1,
      amount_due: 2,
      reference: 3,
      due_date: 4,
    })
    expect(fd.get('sheet')).toBe('0')
    expect(fd.get('header_row')).toBeNull() // the server finds the headings again by itself
    expect(fd.get('table')).toBe('0')
    expect(fd.get('date_order')).toBe('dmy')
    expect(fd.get('file')).not.toBeNull() // the file is sent again with every step
  })

  it('does not apply an uncertain match until the employer confirms it', async () => {
    const columns = [
      col(0, 'Customer', { suggested: 'customer_name', confidence: 'high' }),
      col(1, 'Balance', { suggested: 'amount_due', confidence: 'uncertain', samples: ['100'] }),
      col(2, 'Net Amount', { samples: ['90'] }),
    ]
    const api = await toMapping({ columns, status: { amount_due: 'uncertain' } })
    const next = screen.getByRole('button', { name: 'Continue to review' })
    expect(next).toBeDisabled()
    expect(screen.getByText('Please confirm these matches')).toBeInTheDocument()
    expect(screen.getAllByText('Uncertain').length).toBeGreaterThan(0)
    expect(api.called('POST /api/v1/imports/preview')).toHaveLength(0)
    await userEvent.click(
      screen.getByRole('button', { name: "Yes, that's right: Balance is Amount Due" }),
    )
    expect(next).toBeEnabled()
    expect(screen.queryByText('Please confirm these matches')).not.toBeInTheDocument()
  })

  it('lets the employer pick a different column instead (the choice counts as confirmed)', async () => {
    const columns = [
      col(0, 'Customer', { suggested: 'customer_name', confidence: 'high' }),
      col(1, 'Balance', { suggested: 'amount_due', confidence: 'uncertain', samples: ['100'] }),
      col(2, 'Net Amount', { samples: ['90'] }),
    ]
    const api = await toMapping({ columns, status: { amount_due: 'uncertain' } })
    await userEvent.selectOptions(detectedAs('Net Amount'), 'amount_due')
    expect(detectedAs('Balance')).toHaveValue('') // moved, never two columns for one field
    expect(detectedAs('Net Amount')).toHaveValue('amount_due')
    await userEvent.click(screen.getByRole('button', { name: 'Continue to review' }))
    await screen.findByText('2 customers found · all ready')
    expect(mappingSent(form(api, 'POST /api/v1/imports/preview'))).toMatchObject({
      customer_name: 0,
      amount_due: 2,
    })
  })

  it('blocks continuing while a required column is missing, then allows it once chosen', async () => {
    const columns = [
      col(0, 'Name', { suggested: 'customer_name', confidence: 'high' }),
      col(1, 'Notes'),
    ]
    await toMapping({ columns })
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeDisabled()
    expect(screen.getByText('We still need a column')).toBeInTheDocument()
    expect(screen.getByText(/Choose which column holds the Amount Due/)).toBeInTheDocument()
    expect(screen.getByText('Missing (required)')).toBeInTheDocument()
    await userEvent.selectOptions(detectedAs('Notes'), 'amount_due')
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeEnabled()
    expect(screen.queryByText('We still need a column')).not.toBeInTheDocument()
  })

  it('lets the employer ignore a column', async () => {
    const api = await toMapping()
    await userEvent.selectOptions(detectedAs('Mobile No'), '')
    await userEvent.click(screen.getByRole('button', { name: 'Continue to review' }))
    await screen.findByText('2 customers found · all ready')
    expect(mappingSent(form(api, 'POST /api/v1/imports/preview')).phone).toBeNull()
  })

  it('offers a worksheet picker for multi-sheet workbooks and re-reads on change', async () => {
    const calls: FormData[] = []
    const sheets = [
      { index: 0, name: 'Summary', rows: 3 },
      { index: 1, name: 'October', rows: 9 },
    ]
    await toMapping(
      { sheets, sheet: 1 },
      {
        'POST /api/v1/imports/analyze': async (req: Request) => {
          calls.push(await req.clone().formData())
          return json(analysis({ sheets, sheet: Number(calls.at(-1)?.get('sheet') ?? 1) }))
        },
      },
    )
    const picker = screen.getByRole('combobox', { name: 'Worksheet' })
    expect(picker).toHaveValue('1')
    await userEvent.selectOptions(picker, '0')
    await waitFor(() => expect(calls.some((c) => c.get('sheet') === '0')).toBe(true))
  })

  it('does not show a worksheet picker for a single sheet', async () => {
    await toMapping()
    expect(screen.queryByRole('combobox', { name: 'Worksheet' })).not.toBeInTheDocument()
  })

  it('lets the employer say where the headings are', async () => {
    const calls: FormData[] = []
    await toMapping(
      {},
      {
        'POST /api/v1/imports/analyze': async (req: Request) => {
          calls.push(await req.clone().formData())
          return json(analysis({ header_row: Number(calls.at(-1)?.get('header_row') ?? 1) }))
        },
      },
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Headings end in' }), '3')
    await waitFor(() => expect(calls.some((c) => c.get('header_row') === '3')).toBe(true))
  })

  it('asks which date format the file uses when slash dates are ambiguous (day first by default)', async () => {
    const columns = [
      col(0, 'Customer', { suggested: 'customer_name', confidence: 'high' }),
      col(1, 'Amount', { suggested: 'amount_due', confidence: 'high', samples: ['1'] }),
      col(2, 'Due Date', {
        suggested: 'due_date',
        confidence: 'high',
        samples: ['03/04/2026'],
        date_info: { ambiguous: true, order: 'dmy', examples: ['03/04/2026', '05/06/2026'] },
      }),
    ]
    const api = await toMapping({ columns })
    expect(
      screen.getByText(
        'Some dates could mean DD/MM/YYYY or MM/DD/YYYY. Which format does this file use?',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /DD\/MM\/YYYY/ })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: /MM\/DD\/YYYY/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue to review' }))
    await screen.findByText('2 customers found · all ready')
    expect(form(api, 'POST /api/v1/imports/preview').get('date_order')).toBe('mdy')
  })

  it('does not ask about dates when the file settles the format by itself', async () => {
    await toMapping()
    expect(screen.queryByText(/Which format does this file use/)).not.toBeInTheDocument()
  })

  it('warns when the text came from a scan', async () => {
    await toMapping({
      ocr: true,
      notes: ['This file was read from a scanned document using text recognition.'],
    })
    expect(screen.getByText('Read from a scan')).toBeInTheDocument()
    expect(screen.getByText(/read from a scanned document/)).toBeInTheDocument()
  })

  it('shows the server message if the mapping cannot be applied and stays on the mapping', async () => {
    await toMapping(
      {},
      {
        'POST /api/v1/imports/preview': () =>
          json({ detail: 'Choose a column for: Amount Due.' }, 422),
      },
    )
    await userEvent.click(screen.getByRole('button', { name: 'Continue to review' }))
    expect(await screen.findByText('Choose a column for: Amount Due.')).toBeInTheDocument()
    expect(screen.getByText('Check how we read your file')).toBeInTheDocument()
  })

  it('says what table it found, where its headings are and how many records', async () => {
    await toMapping({
      table: 0,
      tables: [
        {
          index: 0,
          title: 'Group Summary',
          header_rows: [8, 12],
          first_row: 13,
          last_row: 94,
          records: 82,
        },
      ],
      header_row: 12,
      data_rows: 82,
    })
    expect(screen.getByText('Table detected')).toBeInTheDocument()
    expect(screen.getByText(/Headings found in rows 8–12\. 82 records found\./)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Headings end in' })).toHaveValue('12')
  })

  it('asks the employer to choose when Debit and Credit could both be the amount (nothing preselected)', async () => {
    const columns = [
      col(0, 'Particulars', { suggested: 'customer_name', confidence: 'high' }),
      col(1, 'Closing Balance – Debit', {
        samples: ['1716', '31960'],
        count: 50,
        total: '6310779.91',
      }),
      col(2, 'Closing Balance – Credit', {
        samples: ['6712.99', '2950'],
        count: 32,
        total: '7725302.32',
      }),
    ]
    const a = analysis({
      columns,
      notes: ['This looks like an accounting summary with Debit and Credit columns.'],
    })
    a.fields = a.fields.map((f) =>
      f.field === 'amount_due' ? { ...f, status: 'uncertain', column: null, competing: [1, 2] } : f,
    )
    await toMapping(a)
    expect(screen.getByText(/accounting summary with Debit and Credit/)).toBeInTheDocument()
    expect(
      screen.getByText('Choose between: Closing Balance – Debit or Closing Balance – Credit'),
    ).toBeInTheDocument()
    expect(detectedAs('Closing Balance – Debit')).toHaveValue('')
    expect(detectedAs('Closing Balance – Credit')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeDisabled()
    const group = screen.getByRole('group', {
      name: 'Which balance represents the amount you want to collect?',
    })
    expect(
      within(group).getByText(
        'Choose the side that represents money owed to your company. The other side will not be imported.',
      ),
    ).toBeInTheDocument()
    const [debit, credit] = within(group).getAllByRole('radio')
    expect(debit).not.toBeChecked() // never preselected
    expect(credit).not.toBeChecked()
    expect(within(group).getByText('50 customers · ₹63,10,779.91 in total')).toBeInTheDocument()
    expect(within(group).getByText('32 customers · ₹77,25,302.32 in total')).toBeInTheDocument()
    await userEvent.click(debit!)
    expect(detectedAs('Closing Balance – Debit')).toHaveValue('amount_due')
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeEnabled()
  })

  it('shows a calm message, not a made-up mapping, when no table can be identified', async () => {
    const api = await toMapping({
      table: null,
      tables: [],
      structure: 'low',
      columns: [],
      data_rows: 0,
      notes: ["We couldn't confidently identify the table structure."],
    })
    expect(
      screen.getAllByText("We couldn't confidently identify the table structure.").length,
    ).toBeGreaterThan(0)
    expect(screen.queryByRole('region', { name: 'What we need' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue to review' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Column A/)).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Headings end in' })).toBeInTheDocument()
    expect(api.called('POST /api/v1/imports/preview')).toHaveLength(0)
  })

  it('lets the employer pick which table on the sheet to import', async () => {
    const calls: FormData[] = []
    const tables = [
      { index: 0, title: 'Customers', header_rows: [2, 2], first_row: 3, last_row: 5, records: 3 },
      { index: 1, title: 'Suppliers', header_rows: [8, 8], first_row: 9, last_row: 10, records: 2 },
    ]
    await toMapping(
      { tables },
      {
        'POST /api/v1/imports/analyze': async (req: Request) => {
          calls.push(await req.clone().formData())
          return json(analysis({ tables, table: Number(calls.at(-1)?.get('table') ?? 0) }))
        },
      },
    )
    const picker = screen.getByRole('combobox', { name: 'Table' })
    expect(picker).toHaveValue('0')
    expect(
      within(picker).getByRole('option', { name: /Suppliers: rows 9–10 \(2 records\)/ }),
    ).toBeInTheDocument()
    await userEvent.selectOptions(picker, '1')
    await waitFor(() => expect(calls.some((c) => c.get('table') === '1')).toBe(true))
  })

  it('sends a heading row only when the employer chose one by hand', async () => {
    const api = await toMapping(
      {},
      { 'POST /api/v1/imports/analyze': () => json(analysis({ header_row: 3 })) },
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Headings end in' }), '3')
    await waitFor(() =>
      expect(api.called('POST /api/v1/imports/analyze').length).toBeGreaterThan(1),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Continue to review' }))
    await screen.findByText('2 customers found · all ready')
    expect(form(api, 'POST /api/v1/imports/preview').get('header_row')).toBe('3')
    expect(form(api, 'POST /api/v1/imports/preview').get('table')).toBeNull()
  })

  it('goes back to the start to choose a different file', async () => {
    await toMapping()
    await userEvent.click(screen.getByRole('button', { name: 'Choose a different file' }))
    expect(await screen.findByRole('button', { name: 'Upload File' })).toBeInTheDocument()
  })
})

describe('review and confirm', () => {
  async function toReview(previewBody: unknown, extra: Parameters<typeof mockApi>[0] = {}) {
    const api = await openImport({
      'POST /api/v1/imports/analyze': () => json(analysis()),
      'POST /api/v1/imports/preview': () => json(previewBody),
      ...extra,
    })
    await choose(file())
    await userEvent.click(await screen.findByRole('button', { name: 'Continue to review' }))
    await screen.findByLabelText('Customer, row 1')
    return api
  }

  it('shows every customer, flags the broken rows and blocks the import until fixed', async () => {
    const api = await toReview(preview([row(2), bad]))
    expect(screen.getByText('dues.xlsx')).toBeInTheDocument()
    expect(screen.getByText('2 customers found · 1 need fixing')).toBeInTheDocument()
    expect(screen.getByText('Enter the customer name')).toBeInTheDocument()
    expect(screen.getByText('Enter a 10-digit Indian mobile number')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 customers' })).toBeDisabled()
    expect(api.called('POST /api/v1/imports/confirm')).toHaveLength(0)
    expect(
      within(screen.getByRole('list', { name: 'Customers to import' })).getAllByRole('listitem'),
    ).toHaveLength(2)
    expect(screen.getByLabelText('Due date, row 1')).toHaveValue('15/10/2026')
    expect(screen.getByText(/From row 3 of your file/)).toBeInTheDocument()
  })

  it('lists skipped total rows, duplicate warnings and notes', async () => {
    await toReview(
      preview(
        [
          row(2),
          row(3, { warnings: [{ field: 'row', message: 'Looks like a duplicate of row 2' }] }),
        ],
        {
          skipped: [
            { row_number: 9, reason: 'Total or summary row' },
            { row_number: 5, reason: 'Repeated header row' },
          ],
          notes: ["Most amounts couldn't be read. This column may be mapped to the wrong field."],
        },
      ),
    )
    expect(screen.getByText(/Looks like a duplicate of row 2/)).toBeInTheDocument()
    expect(screen.getByText(/2 rows were skipped/)).toBeInTheDocument()
    expect(screen.getByText('Row 9: Total or summary row')).toBeInTheDocument()
    expect(screen.getByText(/Most amounts couldn't be read/)).toBeInTheDocument()
    // a duplicate-looking row is a warning, never a blocker
    expect(screen.getByRole('button', { name: 'Import 2 customers' })).toBeEnabled()
  })

  it('goes back to the mapping to change it', async () => {
    await toReview(preview([row(2)]))
    await userEvent.click(screen.getByRole('button', { name: 'Change mapping' }))
    expect(await screen.findByText('Check how we read your file')).toBeInTheDocument()
  })

  it('re-checks an edited row on the server and enables the import when it is fixed', async () => {
    const fixed = row(3, { customer_name: 'Rahul', phone: '+919876543210' })
    const api = await toReview(preview([row(2), bad]), {
      'POST /api/v1/imports/validate': async (req) => {
        const { rows } = (await req.clone().json()) as { rows: Array<Record<string, unknown>> }
        return strict(rows) ? json([fixed]) : json({ detail: 'extra fields not permitted' }, 422)
      },
    })
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
    await toReview(preview([row(2), bad]))
    await userEvent.click(await screen.findByRole('button', { name: 'Remove row 2' }))
    expect(screen.getByText('1 customer found · all ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 1 customer' })).toBeEnabled()
  })

  it('imports, then shows how many customers were added', async () => {
    const api = await toReview(preview([row(2), row(3)]), {
      'POST /api/v1/imports/validate': () => json([row(2), row(3)]),
      'POST /api/v1/imports/confirm': async (req) => {
        const body = (await req.clone().json()) as { rows: Array<Record<string, unknown>> }
        return strict(body.rows)
          ? json({ imported: 2 })
          : json({ detail: 'extra fields not permitted' }, 422)
      },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 customers' }))
    expect(await screen.findByText('2 customers imported')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View collections' })).toHaveAttribute(
      'href',
      expect.stringContaining('/collections'),
    )
    const body = api.called('POST /api/v1/imports/confirm')[0]!.body as {
      filename: string
      source: string
      rows: unknown[]
    }
    expect(body.filename).toBe('dues.xlsx')
    expect(body.source).toBe('excel')
    expect(body.rows).toHaveLength(2)
    expect(JSON.stringify(body)).not.toMatch(/employer/i)
  })

  it('refreshes the dashboard and collections after an import', async () => {
    await toReview(preview([row(2)]), {
      'POST /api/v1/imports/validate': () => json([row(2)]),
      'POST /api/v1/imports/confirm': () => json({ imported: 1 }),
    })
    const spy = vi.spyOn(client, 'invalidateQueries')
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 customer' }))
    await screen.findByText('1 customer imported')
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))
    expect(keys).toEqual(expect.arrayContaining(['["collections"]', '["dashboard"]']))
  })

  it('Import another file starts again with the Google Sheets form closed', async () => {
    await toReview(preview([row(2)]), {
      'GET /api/v1/imports/google-sheets': () =>
        json({ private_access: false, service_account_email: null }),
      'POST /api/v1/imports/validate': () => json([row(2)]),
      'POST /api/v1/imports/confirm': () => json({ imported: 1 }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 customer' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Import another file' }))
    expect(screen.queryByLabelText('Google Sheets link')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Import from Google Sheets' }))
    expect(await screen.findByLabelText('Google Sheets link')).toBeInTheDocument()
  })

  it('keeps the rows and explains when the import fails', async () => {
    await toReview(preview([row(2)]), {
      'POST /api/v1/imports/validate': () => json([row(2)]),
      'POST /api/v1/imports/confirm': () =>
        json({ detail: 'Some rows still need fixing before they can be imported.' }, 422),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 customer' }))
    expect(
      await screen.findByText('Some rows still need fixing before they can be imported.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Customer, row 1')).toBeInTheDocument()
  })

  it('checks everything again at the moment of import and does not save if a row is now invalid', async () => {
    const api = await toReview(preview([row(2)]), {
      'POST /api/v1/imports/validate': () => json([{ ...bad, row_number: 2 }]),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 customer' }))
    expect(await screen.findByText('Enter the customer name')).toBeInTheDocument()
    expect(api.called('POST /api/v1/imports/confirm')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Import 1 customer' })).toBeDisabled()
  })

  it('asks before leaving a review that has not been imported, and Stay keeps the rows', async () => {
    await toReview(preview([row(2)]))
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without importing?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Customer, row 1')).toBeInTheDocument()
  })

  it('does not interrupt leaving before anything was uploaded', async () => {
    await openImport({})
    await userEvent.click(screen.getByRole('link', { name: 'Collections' }))
    expect(await screen.findByRole('heading', { name: 'Collections' })).toBeInTheDocument()
  })

  it('marks a scanned document on the review screen too', async () => {
    await toReview(
      preview([row(2)], {
        ocr: true,
        source: 'pdf',
        notes: ['This file was read from a scanned document using text recognition.'],
      }),
    )
    expect(screen.getByText('Read from a scan')).toBeInTheDocument()
  })
})
