import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui'
import type { ImportRow } from '@/features/imports/api'
import { cn } from '@/lib/cn'

const FIELDS: Array<{
  key: 'customer_name' | 'phone' | 'amount_due' | 'reference' | 'due_date'
  label: string
  mode?: 'tel' | 'decimal'
}> = [
  { key: 'customer_name', label: 'Customer' },
  { key: 'phone', label: 'Phone', mode: 'tel' },
  { key: 'amount_due', label: 'Amount due (₹)', mode: 'decimal' },
  { key: 'reference', label: 'Reference' },
  { key: 'due_date', label: 'Due date' },
]

export function ReviewList({
  rows,
  disabled,
  onEdit,
  onBlur,
  onRemove,
}: {
  rows: ImportRow[]
  disabled: boolean
  onEdit: (index: number, field: keyof ImportRow, value: string) => void
  onBlur: (index: number) => void
  onRemove: (index: number) => void
}) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Customers to import">
      {rows.map((row, i) => (
        <ReviewRow
          key={row.row_number || i}
          row={row}
          index={i}
          disabled={disabled}
          onEdit={(field, value) => onEdit(i, field, value)}
          onBlur={() => onBlur(i)}
          onRemove={() => onRemove(i)}
        />
      ))}
    </ul>
  )
}

function ReviewRow({
  row,
  index,
  disabled,
  onEdit,
  onBlur,
  onRemove,
}: {
  row: ImportRow
  index: number
  disabled: boolean
  onEdit: (field: keyof ImportRow, value: string) => void
  onBlur: () => void
  onRemove: () => void
}) {
  const errorFor = (field: string) => row.errors.find((e) => e.field === field)?.message
  const rowWarnings = row.warnings ?? []
  return (
    <li
      className={cn(
        'grid gap-3 rounded-card border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_auto]',
        row.errors.length ? 'border-danger' : rowWarnings.length ? 'border-warning' : 'border-line',
      )}
    >
      {FIELDS.map(({ key, label, mode }) => {
        const message = errorFor(key)
        const id = `row-${index}-${key}`
        return (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-sm text-ink-2">
              {label}
            </label>
            <input
              id={id}
              aria-label={`${label}, row ${index + 1}`}
              aria-invalid={message ? true : undefined}
              aria-describedby={message ? `${id}-err` : undefined}
              inputMode={mode}
              placeholder={key === 'due_date' ? 'DD/MM/YYYY' : undefined}
              disabled={disabled}
              value={(row[key] as string | null) ?? ''}
              onChange={(e) => onEdit(key, e.target.value)}
              onBlur={onBlur}
              className={cn(
                'min-h-11 w-full rounded-control border bg-surface px-3',
                message ? 'border-danger' : 'border-field',
              )}
            />
            {message && (
              <p id={`${id}-err`} className="text-sm text-danger">
                {message}
              </p>
            )}
          </div>
        )
      })}
      <div className="flex items-end">
        <Button
          variant="destructive-outline"
          disabled={disabled}
          aria-label={`Remove row ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 className="size-5" aria-hidden="true" />
          <span className="lg:sr-only">Remove</span>
        </Button>
      </div>
      <p className="text-sm text-ink-2 sm:col-span-2 lg:col-span-6">
        {row.row_number > 0 && <span>From row {row.row_number} of your file. </span>}
        {rowWarnings.map((w) => (
          <span key={w.message} className="font-medium text-warning">
            {w.message}.{' '}
          </span>
        ))}
      </p>
    </li>
  )
}
