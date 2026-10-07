import type { ImportRow } from '@/features/imports/api'

/** Server dates are ISO; people type and read DD/MM/YYYY. */
export function showDate(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? '')
}

export function toDisplay(rows: ImportRow[]): ImportRow[] {
  return rows.map((r) => ({
    ...r,
    due_date: r.errors.some((e) => e.field === 'due_date')
      ? r.due_date
      : showDate(r.due_date) || null,
  }))
}
