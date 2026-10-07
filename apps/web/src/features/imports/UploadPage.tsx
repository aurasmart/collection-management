import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Sheet, Upload } from 'lucide-react'
import { Link, useBlocker } from 'react-router'
import { Alert, Badge, Button, Card, ConfirmDialog, Spinner } from '@/components/ui'
import {
  analyzeSource,
  confirmImport,
  previewSource,
  useGoogleConfig,
  validateRows,
  type Analysis,
  type ImportPreview,
  type ImportRow,
  type Source,
} from '@/features/imports/api'
import { MappingStep, type MappingChoice } from '@/features/imports/MappingStep'
import { ReviewList } from '@/features/imports/ReviewList'
import { toDisplay } from '@/features/imports/rows'
import { cn } from '@/lib/cn'
import { routes } from '@/lib/routes'

const MAX_BYTES = 5 * 1024 * 1024
const EXTENSIONS = ['.xlsx', '.xls', '.csv', '.pdf']

type Step =
  | { kind: 'choose' }
  | { kind: 'reading'; what: string }
  | { kind: 'mapping'; busy: boolean }
  | { kind: 'review'; saving: boolean }
  | { kind: 'done'; imported: number }

export function UploadPage() {
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [source, setSource] = useState<Source | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [manualHeader, setManualHeader] = useState<number | null>(null)
  const [sheetForm, setSheetForm] = useState(false)
  const [sheetUrl, setSheetUrl] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setSource(null)
    setAnalysis(null)
    setPreview(null)
    setRows([])
    setError(null)
    setSheetForm(false)
    setSheetUrl('')
    setManualHeader(null)
    setStep({ kind: 'choose' })
  }

  async function analyze(
    next: Source,
    opts: { sheet?: number; headerRow?: number; table?: number } = {},
  ) {
    setError(null)
    const result = await analyzeSource(next, opts)
    if (!result.ok) {
      setError(result.message)
      // Re-analysing an already open file keeps the mapping screen; a first read goes back to start.
      setStep(analysis ? { kind: 'mapping', busy: false } : { kind: 'choose' })
      return
    }
    setSource(next)
    setAnalysis(result.data)
    setStep({ kind: 'mapping', busy: false })
  }

  async function readFile(file: File | undefined) {
    if (!file) return
    setError(null)
    const name = file.name.toLowerCase()
    if (!EXTENSIONS.some((e) => name.endsWith(e))) {
      setError('We can read Excel (.xlsx, .xls), CSV and PDF files. Please upload one of those.')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('This file is larger than 5 MB. Split it and upload in parts.')
      return
    }
    setAnalysis(null)
    setStep({
      kind: 'reading',
      what: name.endsWith('.pdf') ? 'Reading your PDF…' : 'Reading your file…',
    })
    await analyze({ kind: 'file', file })
  }

  async function readSheet() {
    const url = sheetUrl.trim()
    if (!url) {
      setError('Paste the link to your Google Sheet.')
      return
    }
    setAnalysis(null)
    setManualHeader(null)
    setStep({ kind: 'reading', what: 'Reading your Google Sheet…' })
    await analyze({ kind: 'sheet', url })
  }

  async function changeSheet(sheet: number) {
    if (!source) return
    setManualHeader(null)
    setStep({ kind: 'mapping', busy: true })
    await analyze(source, { sheet })
  }

  async function changeTable(table: number) {
    if (!source || !analysis) return
    setManualHeader(null)
    setStep({ kind: 'mapping', busy: true })
    await analyze(source, { sheet: analysis.sheet, table })
  }

  async function changeHeaderRow(headerRow: number) {
    if (!source || !analysis) return
    setManualHeader(headerRow)
    setStep({ kind: 'mapping', busy: true })
    await analyze(source, { sheet: analysis.sheet, headerRow })
  }

  async function toReview(next: MappingChoice) {
    if (!source || !analysis) return
    setError(null)
    setStep({ kind: 'mapping', busy: true })
    const result = await previewSource(source, {
      sheet: analysis.sheet,
      headerRow: manualHeader,
      table: manualHeader === null ? analysis.table : null,
      mapping: next.mapping,
      dateOrder: next.dateOrder,
    })
    if (!result.ok) {
      setError(result.message)
      setStep({ kind: 'mapping', busy: false })
      return
    }
    setPreview(result.data)
    setRows(toDisplay(result.data.rows))
    setStep({ kind: 'review', saving: false })
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
    if (step.kind !== 'review' || !preview) return
    setError(null)
    setStep({ kind: 'review', saving: true })
    // Check everything once more right now: an edit may still be unchecked (the click can land before
    // that field's own check finished), and the server must see exactly what will be saved.
    const checked = await validateRows(rows)
    if (!checked.ok) {
      setError(checked.message)
      setStep({ kind: 'review', saving: false })
      return
    }
    if (checked.data.some((r) => r.errors.length > 0)) {
      setRows(toDisplay(checked.data))
      setStep({ kind: 'review', saving: false })
      return
    }
    const result = await confirmImport(preview.filename, preview.source, checked.data)
    if (result.ok) {
      // The dashboard and the collections list were loaded before these customers existed.
      void qc.invalidateQueries({ queryKey: ['collections'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      setStep({ kind: 'done', imported: result.data.imported })
      return
    }
    setError(result.message)
    setStep({ kind: 'review', saving: false })
  }

  const invalid = rows.filter((r) => r.errors.length > 0).length
  const canImport = rows.length > 0 && invalid === 0

  // Rows that are being reviewed exist only in this browser tab until they are imported.
  const unsaved = step.kind === 'review'
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
      <h1 className="text-2xl font-semibold">Import customer collections</h1>

      {error && <Alert tone="error">{error}</Alert>}

      {(step.kind === 'choose' || step.kind === 'reading') && (
        <Card className="flex flex-col gap-4">
          <p className="text-ink-2">
            Upload an Excel, CSV or PDF file, or import from Google Sheets. We'll automatically
            detect customer names, phone numbers, outstanding amounts, references and dates. You can
            review and correct the mapping before anything is imported.
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
                <span>{step.what}</span>
              </div>
            ) : (
              <>
                <FileSpreadsheet className="size-10 text-ink-2" aria-hidden="true" />
                <p>Drag a file here, or</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv,.pdf"
                  className="sr-only"
                  aria-label="Customer file (Excel, CSV or PDF)"
                  onChange={(e) => {
                    void readFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => inputRef.current?.click()}>
                    <Upload className="size-5" aria-hidden="true" />
                    Upload File
                  </Button>
                  <Button
                    variant="secondary"
                    aria-expanded={sheetForm}
                    onClick={() => setSheetForm((v) => !v)}
                  >
                    <Sheet className="size-5" aria-hidden="true" />
                    Import from Google Sheets
                  </Button>
                </div>
                <p className="text-sm text-ink-2">
                  .xlsx, .xls, .csv or .pdf · up to 5 MB · PDFs up to 10 pages
                </p>
              </>
            )}
          </div>
          {sheetForm && step.kind === 'choose' && (
            <GoogleSheetForm url={sheetUrl} onUrl={setSheetUrl} onRead={() => void readSheet()} />
          )}
          <a
            href={`${import.meta.env.BASE_URL}sample-customers.csv`}
            className="inline-flex min-h-11 items-center text-accent hover:underline"
            download
          >
            Download sample template
          </a>
          <p className="text-sm text-ink-2">
            The template is optional. Your file can use its own column names.
          </p>
        </Card>
      )}

      {step.kind === 'mapping' && analysis && (
        <MappingStep
          key={`${analysis.sheet}-${analysis.table}-${analysis.header_row}-${analysis.filename}`}
          analysis={analysis}
          busy={step.busy}
          onChangeSheet={(s) => void changeSheet(s)}
          onChangeHeaderRow={(r) => void changeHeaderRow(r)}
          onChangeTable={(t) => void changeTable(t)}
          onBack={reset}
          onContinue={(c) => void toReview(c)}
        />
      )}

      {step.kind === 'review' && preview && (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {preview.filename}
                {preview.ocr && <Badge tone="ocr">Read from a scan</Badge>}
              </p>
              <p aria-live="polite" className="text-ink-2">
                {rows.length} {rows.length === 1 ? 'customer' : 'customers'} found
                {invalid > 0 ? ` · ${invalid} need fixing` : ' · all ready'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={step.saving}
                onClick={() => {
                  setPreview(null)
                  setRows([])
                  setError(null)
                  setStep({ kind: 'mapping', busy: false })
                }}
              >
                Change mapping
              </Button>
              <Button loading={step.saving} disabled={!canImport} onClick={() => void confirm()}>
                {step.saving
                  ? 'Importing…'
                  : `Import ${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`}
              </Button>
            </div>
          </Card>
          {preview.notes.map((n) => (
            <Alert key={n} tone={preview.ocr && n.includes('scanned') ? 'warning' : 'info'}>
              {n}
            </Alert>
          ))}
          {preview.skipped.length > 0 && (
            <details className="rounded-card border border-line bg-surface p-3">
              <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                {preview.skipped.length} {preview.skipped.length === 1 ? 'row was' : 'rows were'}{' '}
                skipped (totals and repeated headings)
              </summary>
              <ul className="mt-2 flex flex-col gap-1 text-ink-2">
                {preview.skipped.map((s) => (
                  <li key={s.row_number}>
                    Row {s.row_number}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {invalid > 0 && (
            <Alert tone="warning">Fix the highlighted rows (or remove them) to continue.</Alert>
          )}
          <ReviewList
            rows={rows}
            disabled={step.saving}
            onEdit={edit}
            onBlur={(i) => void recheck(i)}
            onRemove={(i) => setRows((prev) => prev.filter((_, j) => j !== i))}
          />
        </>
      )}

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => {
          if (!o && blocker.state === 'blocked') blocker.reset()
        }}
        title="Leave without importing?"
        description="These customers have not been saved yet. If you leave, you will need to import the file again."
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
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}

function GoogleSheetForm({
  url,
  onUrl,
  onRead,
}: {
  url: string
  onUrl: (v: string) => void
  onRead: () => void
}) {
  const config = useGoogleConfig(true)
  const email = config.data?.service_account_email
  return (
    <form
      className="flex flex-col gap-3 rounded-card border border-line bg-canvas p-4"
      aria-label="Import from Google Sheets"
      onSubmit={(e) => {
        e.preventDefault()
        onRead()
      }}
    >
      <label className="flex flex-col gap-1 font-medium" htmlFor="sheet-url">
        Google Sheets link
      </label>
      <input
        id="sheet-url"
        type="url"
        inputMode="url"
        autoCapitalize="none"
        autoComplete="off"
        placeholder="https://docs.google.com/spreadsheets/d/…"
        value={url}
        onChange={(e) => onUrl(e.target.value)}
        className="min-h-11 w-full rounded-control border border-field bg-surface px-3"
      />
      <div className="text-sm text-ink-2">
        <p>
          <strong>Anyone with the link can view:</strong> paste the link and we'll read it.
        </p>
        {config.data?.private_access && email ? (
          <p>
            <strong>Private sheet:</strong> share the sheet with our Google service account as
            Viewer, then paste the link. Share it with{' '}
            <code className="font-mono break-all">{email}</code>.
          </p>
        ) : (
          <p>
            <strong>Private sheet:</strong> importing private sheets isn't set up yet. Turn on
            "Anyone with the link can view" in Google Sheets to import it.
          </p>
        )}
      </div>
      <div>
        <Button type="submit">Read sheet</Button>
      </div>
    </form>
  )
}
