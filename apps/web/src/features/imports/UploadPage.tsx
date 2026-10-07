import { useEffect, useRef, useState } from 'react'
import { FileSpreadsheet, Trash2, Upload } from 'lucide-react'
import { Link, useBlocker } from 'react-router'
import { Alert, Button, Card, ConfirmDialog, Spinner } from '@/components/ui'
import {
  confirmImport,
  previewFile,
  validateRows,
  type ImportPreview,
  type ImportRow,
} from '@/features/imports/api'
import { cn } from '@/lib/cn'
import { routes } from '@/lib/routes'

const MAX_BYTES = 5 * 1024 * 1024

type Step =
  | { kind: 'choose' }
  | { kind: 'reading' }
  | { kind: 'review'; filename: string }
  | { kind: 'saving'; filename: string }
  | { kind: 'done'; imported: number }

/** Server dates are ISO; people type and read DD/MM/YYYY. */
function showDate(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? '')
}

function toDisplay(rows: ImportRow[]): ImportRow[] {
  return rows.map((r) => ({
    ...r,
    due_date: r.errors.some((e) => e.field === 'due_date')
      ? r.due_date
      : showDate(r.due_date) || null,
  }))
}

export function UploadPage() {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [rows, setRows] = useState<ImportRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function readFile(file: File | undefined) {
    if (!file) return
    setError(null)
    const name = file.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.csv')) {
      setError('We can read Excel (.xlsx) and CSV files. Please upload one of those.')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('This file is larger than 5 MB. Split it and upload in parts.')
      return
    }
    setStep({ kind: 'reading' })
    const result = await previewFile(file)
    if (!result.ok) {
      setError(result.message)
      setStep({ kind: 'choose' })
      return
    }
    const preview: ImportPreview = result.data
    setRows(toDisplay(preview.rows))
    setStep({ kind: 'review', filename: preview.filename })
  }

  function edit(index: number, field: keyof ImportRow, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  }

  async function recheck(index: number) {
    const row = rows[index]
    if (!row) return
    const result = await validateRows([row])
    const fresh = result.ok ? result.data[0] : undefined
    if (fresh) {
      setRows((prev) => prev.map((r, i) => (i === index && r === row ? toDisplay([fresh])[0]! : r)))
    }
  }

  async function confirm() {
    if (step.kind !== 'review') return
    setError(null)
    setStep({ kind: 'saving', filename: step.filename })
    // Check everything once more right now: an edit may still be unchecked (the click can land before
    // that field's own check finished), and the server must see exactly what will be saved.
    const checked = await validateRows(rows)
    if (!checked.ok) {
      setError(checked.message)
      setStep({ kind: 'review', filename: step.filename })
      return
    }
    if (checked.data.some((r) => r.errors.length > 0)) {
      setRows(toDisplay(checked.data))
      setStep({ kind: 'review', filename: step.filename })
      return
    }
    const result = await confirmImport(step.filename, checked.data)
    if (result.ok) {
      setStep({ kind: 'done', imported: result.data.imported })
      return
    }
    setError(result.message)
    setStep({ kind: 'review', filename: step.filename })
  }

  const invalid = rows.filter((r) => r.errors.length > 0).length
  const canImport = rows.length > 0 && invalid === 0

  // Rows that are being reviewed exist only in this browser tab until they are imported.
  const unsaved = step.kind === 'review' || step.kind === 'saving'
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      unsaved && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (!unsaved) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Upload customers</h1>

      {error && <Alert tone="error">{error}</Alert>}

      {(step.kind === 'choose' || step.kind === 'reading') && (
        <Card className="flex flex-col gap-4">
          <p className="text-ink-2">
            Upload an Excel (.xlsx) or CSV file with these columns:{' '}
            <strong>Customer Name, Phone Number, Amount Due, Reference</strong> and optionally{' '}
            <strong>Due Date</strong>. You'll check every row before anything is saved.
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void readFile(e.dataTransfer.files[0])
            }}
            className={cn(
              'grid place-items-center gap-3 rounded-card border-2 border-dashed p-8 text-center',
              dragging ? 'border-accent bg-accent-soft' : 'border-line',
            )}
          >
            {step.kind === 'reading' ? (
              <div className="flex items-center gap-2" role="status">
                <Spinner label="" />
                <span>Reading your file…</span>
              </div>
            ) : (
              <>
                <FileSpreadsheet className="size-10 text-ink-2" aria-hidden="true" />
                <p>Drag a file here, or</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.csv"
                  className="sr-only"
                  aria-label="Customer file (.xlsx or .csv)"
                  onChange={(e) => {
                    void readFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                <Button onClick={() => inputRef.current?.click()}>
                  <Upload className="size-5" aria-hidden="true" />
                  Choose file
                </Button>
                <p className="text-sm text-ink-2">.xlsx or .csv, up to 5 MB</p>
              </>
            )}
          </div>
          <a
            href={`${import.meta.env.BASE_URL}sample-customers.csv`}
            className="inline-flex min-h-11 items-center text-accent hover:underline"
            download
          >
            Download a sample CSV
          </a>
        </Card>
      )}

      {(step.kind === 'review' || step.kind === 'saving') && (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">{step.filename}</p>
              <p aria-live="polite" className="text-ink-2">
                {rows.length} {rows.length === 1 ? 'customer' : 'customers'} found
                {invalid > 0 ? ` · ${invalid} need fixing` : ' · all ready'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={step.kind === 'saving'}
                onClick={() => {
                  setRows([])
                  setError(null)
                  setStep({ kind: 'choose' })
                }}
              >
                Choose a different file
              </Button>
              <Button
                loading={step.kind === 'saving'}
                disabled={!canImport}
                onClick={() => void confirm()}
              >
                {step.kind === 'saving'
                  ? 'Importing…'
                  : `Import ${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`}
              </Button>
            </div>
          </Card>
          {invalid > 0 && (
            <Alert tone="warning">Fix the highlighted rows (or remove them) to continue.</Alert>
          )}
          <ul className="flex flex-col gap-3" aria-label="Customers to import">
            {rows.map((row, i) => (
              <ReviewRow
                key={row.row_number || i}
                row={row}
                index={i}
                disabled={step.kind === 'saving'}
                onEdit={(field, value) => edit(i, field, value)}
                onBlur={() => void recheck(i)}
                onRemove={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => {
          if (!o && blocker.state === 'blocked') blocker.reset()
        }}
        title="Leave without importing?"
        description="These customers have not been saved yet. If you leave, you will need to upload the file again."
        confirmLabel="Leave"
        cancelLabel="Stay"
        destructive
        onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
      />

      {step.kind === 'done' && (
        <Card className="flex flex-col items-start gap-4">
          <Alert
            tone="success"
            title={`${step.imported} ${step.imported === 1 ? 'customer' : 'customers'} imported`}
          >
            They are in your Collections as Pending.
          </Alert>
          <div className="flex gap-2">
            <Link
              to={routes.collections}
              className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-medium text-white hover:bg-accent-hover"
            >
              View collections
            </Link>
            <Button
              variant="secondary"
              onClick={() => {
                setRows([])
                setStep({ kind: 'choose' })
              }}
            >
              Upload another file
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}

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
  return (
    <li
      className={cn(
        'grid gap-3 rounded-card border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_auto]',
        row.errors.length ? 'border-danger' : 'border-line',
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
    </li>
  )
}
