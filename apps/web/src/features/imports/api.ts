import { useQuery } from '@tanstack/react-query'
import type { components } from '@collections/api-types'
import { api } from '@/lib/api'
import { useAuth } from '@/features/auth/AuthProvider'

export type ImportRow = components['schemas']['RowOut']
export type ImportPreview = components['schemas']['PreviewOut']
export type Analysis = components['schemas']['AnalysisOut']
export type FieldKey = Analysis['fields'][number]['field']
export type ColumnInfo = Analysis['columns'][number]

export type ImportResult<T> = { ok: true; data: T } | { ok: false; message: string }

/** Where the customers come from. The browser keeps this and sends it with every step (stateless server). */
export type Source = { kind: 'file'; file: File } | { kind: 'sheet'; url: string }
export type Mapping = Record<FieldKey, number | null>
export type DateOrder = 'dmy' | 'mdy'

export const FIELD_ORDER: FieldKey[] = [
  'customer_name',
  'phone',
  'amount_due',
  'reference',
  'due_date',
]
export const FIELD_LABELS: Record<FieldKey, string> = {
  customer_name: 'Customer Name',
  phone: 'Phone Number',
  amount_due: 'Amount Due',
  reference: 'Reference',
  due_date: 'Due Date',
}
export const REQUIRED_FIELDS: FieldKey[] = ['customer_name', 'amount_due']

const NETWORK = "Can't reach the server. Check your connection and try again."

function messageOf(error: unknown, fallback: string): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail
  return typeof detail === 'string' ? detail : fallback
}

function formFor(source: Source, extra: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData()
  if (source.kind === 'file') fd.append('file', source.file)
  else fd.append('sheet_url', source.url)
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) fd.append(k, v)
  return fd
}

export async function analyzeSource(
  source: Source,
  opts: { sheet?: number; headerRow?: number } = {},
): Promise<ImportResult<Analysis>> {
  try {
    const { data, error } = await api.POST('/api/v1/imports/analyze', {
      body: {} as never, // typed loosely; the serializer sends the real multipart data
      bodySerializer: () =>
        formFor(source, {
          sheet: opts.sheet?.toString(),
          header_row: opts.headerRow?.toString(),
        }),
    })
    if (data) return { ok: true, data }
    return { ok: false, message: messageOf(error, "We couldn't read this file.") }
  } catch {
    return { ok: false, message: NETWORK }
  }
}

export async function previewSource(
  source: Source,
  opts: { sheet: number; headerRow: number; mapping: Mapping; dateOrder: DateOrder },
): Promise<ImportResult<ImportPreview>> {
  try {
    const { data, error } = await api.POST('/api/v1/imports/preview', {
      body: {} as never,
      bodySerializer: () =>
        formFor(source, {
          sheet: String(opts.sheet),
          header_row: String(opts.headerRow),
          mapping: JSON.stringify(opts.mapping),
          date_order: opts.dateOrder,
        }),
    })
    if (data) return { ok: true, data }
    return { ok: false, message: messageOf(error, "We couldn't read this file.") }
  } catch {
    return { ok: false, message: NETWORK }
  }
}

export function useGoogleConfig(enabled: boolean) {
  const { status } = useAuth()
  return useQuery({
    queryKey: ['google-sheets-config'],
    enabled: enabled && status === 'signed-in',
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/imports/google-sheets')
      if (error || !data) throw new Error('Could not load Google Sheets settings')
      return data
    },
  })
}

type RowInput = Pick<
  ImportRow,
  'row_number' | 'customer_name' | 'phone' | 'amount_due' | 'reference' | 'due_date'
>

/** Send only the editable fields. The server rejects unknown fields (and re-computes `errors` itself). */
const toInput = (r: ImportRow): RowInput => ({
  row_number: r.row_number,
  customer_name: r.customer_name,
  phone: r.phone,
  amount_due: r.amount_due,
  reference: r.reference,
  due_date: r.due_date,
})

/** Ask the server to re-check (and normalise) rows the employer edited. */
export async function validateRows(rows: ImportRow[]): Promise<ImportResult<ImportRow[]>> {
  try {
    const { data } = await api.POST('/api/v1/imports/validate', {
      body: { rows: rows.map(toInput) },
    })
    return data ? { ok: true, data } : { ok: false, message: "Couldn't check that row." }
  } catch {
    return { ok: false, message: NETWORK }
  }
}

export async function confirmImport(
  filename: string,
  source: ImportPreview['source'],
  rows: ImportRow[],
): Promise<ImportResult<{ imported: number }>> {
  try {
    const { data, error } = await api.POST('/api/v1/imports/confirm', {
      body: {
        filename,
        source: source as 'excel' | 'csv' | 'pdf' | 'google_sheets',
        rows: rows.map(toInput),
      },
    })
    if (data) return { ok: true, data }
    return { ok: false, message: messageOf(error, "Couldn't import. Nothing was saved.") }
  } catch {
    return { ok: false, message: NETWORK }
  }
}
