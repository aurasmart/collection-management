import type { components } from '@collections/api-types'
import { api } from '@/lib/api'

export type ImportRow = components['schemas']['RowOut']
export type ImportPreview = components['schemas']['PreviewOut']

export type ImportResult<T> = { ok: true; data: T } | { ok: false; message: string }

const NETWORK = "Can't reach the server. Check your connection and try again."

function messageOf(error: unknown, fallback: string): string {
  const detail = (error as { detail?: unknown } | undefined)?.detail
  return typeof detail === 'string' ? detail : fallback
}

export async function previewFile(file: File): Promise<ImportResult<ImportPreview>> {
  try {
    const { data, error } = await api.POST('/api/v1/imports/preview', {
      body: { file: '' }, // typed as a string; the serializer sends real multipart data
      bodySerializer: () => {
        const fd = new FormData()
        fd.append('file', file)
        return fd
      },
    })
    if (data) return { ok: true, data }
    return { ok: false, message: messageOf(error, "We couldn't read this file.") }
  } catch {
    return { ok: false, message: NETWORK }
  }
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
  rows: ImportRow[],
): Promise<ImportResult<{ imported: number }>> {
  try {
    const { data, error } = await api.POST('/api/v1/imports/confirm', {
      body: { filename, rows: rows.map(toInput) },
    })
    if (data) return { ok: true, data }
    return { ok: false, message: messageOf(error, "Couldn't import. Nothing was saved.") }
  } catch {
    return { ok: false, message: NETWORK }
  }
}
