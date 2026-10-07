import { useMemo, useState } from 'react'
import { Check, CircleAlert, CircleHelp, Minus } from 'lucide-react'
import { Alert, Badge, Button, Card } from '@/components/ui'
import {
  FIELD_LABELS,
  FIELD_ORDER,
  REQUIRED_FIELDS,
  type Analysis,
  type DateOrder,
  type FieldKey,
  type Mapping,
} from '@/features/imports/api'
import { cn } from '@/lib/cn'

export interface MappingChoice {
  mapping: Mapping
  dateOrder: DateOrder
}

type Status = 'detected' | 'uncertain' | 'confirmed' | 'missing'

/**
 * "Your column -> Detected as". Nothing low-confidence is applied silently: an uncertain match must
 * be confirmed (or changed) by the employer before the review step.
 */
export function MappingStep({
  analysis,
  busy,
  onChangeSheet,
  onChangeHeaderRow,
  onBack,
  onContinue,
}: {
  analysis: Analysis
  busy: boolean
  onChangeSheet: (sheet: number) => void
  onChangeHeaderRow: (row: number) => void
  onBack: () => void
  onContinue: (choice: MappingChoice) => void
}) {
  // column index -> field (or '' = ignored). Start from the server's suggestion.
  const [assigned, setAssigned] = useState<Record<number, FieldKey | ''>>(() => {
    const out: Record<number, FieldKey | ''> = {}
    for (const c of analysis.columns) out[c.index] = ''
    for (const f of analysis.fields) if (f.column !== null) out[f.column] = f.field
    return out
  })
  const [confirmed, setConfirmed] = useState<Set<FieldKey>>(new Set())
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null)
  const original = useMemo(() => {
    const m = new Map<
      FieldKey,
      { column: number | null; status: 'detected' | 'uncertain' | 'missing' }
    >()
    for (const f of analysis.fields) m.set(f.field, { column: f.column, status: f.status })
    return m
  }, [analysis])

  const columnOf = (field: FieldKey): number | null => {
    for (const [col, f] of Object.entries(assigned)) if (f === field) return Number(col)
    return null
  }

  function statusOf(field: FieldKey): Status {
    const col = columnOf(field)
    if (col === null) return 'missing'
    if (confirmed.has(field)) return 'confirmed'
    const o = original.get(field)
    if (o && o.column === col && o.status !== 'missing') return o.status
    return 'confirmed' // the employer picked this column themselves
  }

  function choose(col: number, value: FieldKey | '') {
    setAssigned((prev) => {
      const next = { ...prev }
      if (value)
        for (const k of Object.keys(next)) if (next[Number(k)] === value) next[Number(k)] = ''
      next[col] = value
      return next
    })
    if (value) setConfirmed((s) => new Set(s).add(value))
  }

  const dateCol = columnOf('due_date')
  const dateInfo = dateCol !== null ? analysis.columns[dateCol]?.date_info : null
  const effectiveOrder: DateOrder = dateOrder ?? dateInfo?.order ?? 'dmy'
  const missingRequired = REQUIRED_FIELDS.filter((f) => columnOf(f) === null)
  const unconfirmed = FIELD_ORDER.filter((f) => statusOf(f) === 'uncertain')
  const ready = missingRequired.length === 0 && unconfirmed.length === 0

  const mapping = (): Mapping => {
    const out = {} as Mapping
    for (const f of FIELD_ORDER) out[f] = columnOf(f)
    return out
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Check how we read your file</h2>
            <p className="text-ink-2">
              {analysis.filename} · {analysis.data_rows} {analysis.data_rows === 1 ? 'row' : 'rows'}{' '}
              below the headings
            </p>
          </div>
          {analysis.ocr && <Badge tone="ocr">Read from a scan</Badge>}
        </div>
        <div className="flex flex-wrap gap-4">
          {analysis.sheets.length > 1 && (
            <label className="flex flex-col gap-1 font-medium">
              Worksheet
              <select
                className="min-h-11 rounded-control border border-field bg-surface px-3 font-normal"
                value={analysis.sheet}
                disabled={busy}
                onChange={(e) => onChangeSheet(Number(e.target.value))}
              >
                {analysis.sheets.map((s) => (
                  <option key={s.index} value={s.index}>
                    {s.name} ({s.rows} rows)
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 font-medium">
            Headings are in
            <select
              className="min-h-11 rounded-control border border-field bg-surface px-3 font-normal"
              value={analysis.header_row}
              disabled={busy}
              onChange={(e) => onChangeHeaderRow(Number(e.target.value))}
            >
              <option value={0}>No heading row</option>
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  Row {i + 1}
                </option>
              ))}
            </select>
          </label>
        </div>
        {analysis.notes.map((n) => (
          <Alert key={n} tone={analysis.ocr && n.includes('scanned') ? 'warning' : 'info'}>
            {n}
          </Alert>
        ))}
      </Card>

      <section aria-label="What we need" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {FIELD_ORDER.map((f) => {
          const status = statusOf(f)
          const col = columnOf(f)
          return (
            <div
              key={f}
              className={cn(
                'flex flex-col gap-1 rounded-card border bg-surface p-3',
                status === 'missing' && REQUIRED_FIELDS.includes(f)
                  ? 'border-danger'
                  : status === 'uncertain'
                    ? 'border-warning'
                    : 'border-line',
              )}
            >
              <p className="font-medium">
                {FIELD_LABELS[f]}
                {REQUIRED_FIELDS.includes(f) && (
                  <span className="text-danger" aria-hidden="true">
                    {' '}
                    *
                  </span>
                )}
              </p>
              <StatusBadge status={status} required={REQUIRED_FIELDS.includes(f)} />
              <p className="text-sm break-words text-ink-2">
                {col !== null
                  ? `From "${analysis.columns[col]?.header ?? ''}"`
                  : 'No column chosen'}
              </p>
            </div>
          )
        })}
      </section>

      <Card className="flex flex-col gap-3" aria-label="Column mapping">
        <h2 className="text-lg font-semibold">Your columns</h2>
        <table className="block w-full md:table">
          <caption className="sr-only">What each column in your file means</caption>
          <thead className="hidden text-left text-sm text-ink-2 md:table-header-group">
            <tr>
              {['Your column', 'Example values', 'Detected as', 'Status'].map((h) => (
                <th key={h} scope="col" className="border-b border-line px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {analysis.columns.map((c) => {
              const field = assigned[c.index] ?? ''
              const status: Status | 'ignored' = field ? statusOf(field) : 'ignored'
              return (
                <tr
                  key={c.index}
                  className="mb-3 block rounded-card border border-line p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-b md:p-0"
                >
                  <td className="block py-1 font-medium break-words md:table-cell md:px-3 md:py-3">
                    <span className="text-sm text-ink-2 md:hidden">Your column: </span>
                    {c.header}
                  </td>
                  <td className="block py-1 text-ink-2 break-words md:table-cell md:px-3 md:py-3">
                    <span className="text-sm md:hidden">Examples: </span>
                    {c.samples.length ? c.samples.join(' · ') : '—'}
                  </td>
                  <td className="block py-1 md:table-cell md:px-3 md:py-3">
                    <select
                      aria-label={`Detected as, for column ${c.header}`}
                      className="min-h-11 w-full rounded-control border border-field bg-surface px-3"
                      value={field}
                      disabled={busy}
                      onChange={(e) => choose(c.index, e.target.value as FieldKey | '')}
                    >
                      <option value="">Ignore this column</option>
                      {FIELD_ORDER.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABELS[f]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="block py-1 md:table-cell md:px-3 md:py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {status === 'ignored' ? (
                        <Badge tone="neutral">
                          <Minus className="size-4" aria-hidden="true" />
                          Ignored
                        </Badge>
                      ) : (
                        <StatusBadge status={status} required={false} />
                      )}
                      {field && status === 'uncertain' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Yes, that's right: ${c.header} is ${FIELD_LABELS[field]}`}
                          onClick={() => setConfirmed((s) => new Set(s).add(field))}
                        >
                          Yes, that's right
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>

      {dateInfo?.ambiguous && (
        <Card className="flex flex-col gap-3" aria-label="Date format">
          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold">
              Some dates could mean DD/MM/YYYY or MM/DD/YYYY. Which format does this file use?
            </legend>
            <p className="text-sm text-ink-2">
              For example {dateInfo.examples.join(', ')}. We assume day first unless you say
              otherwise.
            </p>
            {(
              [
                ['dmy', 'DD/MM/YYYY', 'day first, so 03/04/2026 is 3 April 2026'],
                ['mdy', 'MM/DD/YYYY', 'month first, so 03/04/2026 is 4 March 2026'],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="date-order"
                  className="size-5 accent-accent"
                  checked={effectiveOrder === value}
                  onChange={() => setDateOrder(value)}
                />
                <span>
                  <strong>{label}</strong> — {hint}
                </span>
              </label>
            ))}
          </fieldset>
        </Card>
      )}
      {dateInfo && !dateInfo.ambiguous && dateInfo.order === 'mdy' && (
        <Alert tone="info">
          The dates in this file are month first (MM/DD/YYYY). We'll read them that way.
        </Alert>
      )}

      {missingRequired.length > 0 && (
        <Alert tone="warning" title="We still need a column">
          Choose which column holds the {missingRequired.map((f) => FIELD_LABELS[f]).join(' and ')}.
        </Alert>
      )}
      {unconfirmed.length > 0 && (
        <Alert tone="warning" title="Please confirm these matches">
          We weren't sure about {unconfirmed.map((f) => FIELD_LABELS[f]).join(', ')}. Confirm the
          column, or choose a different one.
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          Choose a different file
        </Button>
        <Button
          loading={busy}
          disabled={!ready}
          onClick={() => onContinue({ mapping: mapping(), dateOrder: effectiveOrder })}
        >
          Continue to review
        </Button>
      </div>
    </div>
  )
}

function StatusBadge({ status, required }: { status: Status; required: boolean }) {
  switch (status) {
    case 'detected':
      return (
        <Badge tone="success">
          <Check className="size-4" aria-hidden="true" />
          Detected
        </Badge>
      )
    case 'confirmed':
      return (
        <Badge tone="info">
          <Check className="size-4" aria-hidden="true" />
          Confirmed
        </Badge>
      )
    case 'uncertain':
      return (
        <Badge tone="warning">
          <CircleHelp className="size-4" aria-hidden="true" />
          Uncertain
        </Badge>
      )
    default:
      return (
        <Badge tone={required ? 'danger' : 'neutral'}>
          <CircleAlert className="size-4" aria-hidden="true" />
          Missing{required ? ' (required)' : ''}
        </Badge>
      )
  }
}
