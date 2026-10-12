import { useId, useRef, useState } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import { Alert, Button, Modal, TextField, useToast } from '@/components/ui'
import { RECEIPT_ACCEPT, receiptProblem } from '@/lib/receipt'
import {
  extractReceipt,
  useCreateEntry,
  useUpdateEntry,
  type PettyCashEntry,
  type PettyCashProposal,
} from '@/features/petty-cash/api'

type Fields = 'transaction_id' | 'txn_date' | 'payment_to' | 'payment_from' | 'remarks' | 'amount'
type Values = Record<Fields, string>

const LABELS: Record<Fields, string> = {
  transaction_id: 'Transaction ID',
  txn_date: 'Date',
  payment_to: 'Payment to',
  payment_from: 'Payment from',
  remarks: 'Remarks',
  amount: 'Amount (₹)',
}

function fromProposal(p: PettyCashProposal): Values {
  return {
    transaction_id: p.transaction_id ?? '',
    txn_date: p.txn_date ?? '',
    payment_to: p.payment_to ?? '',
    payment_from: p.payment_from ?? '',
    remarks: p.remarks ?? '',
    amount: p.amount ?? '',
  }
}

function fromEntry(e: PettyCashEntry): Values {
  return {
    transaction_id: e.transaction_id ?? '',
    txn_date: e.txn_date ?? '',
    payment_to: e.payment_to ?? '',
    payment_from: e.payment_from ?? '',
    remarks: e.remarks ?? '',
    amount: e.amount,
  }
}

const MAX_FILES = 20

type Item = {
  file: File | null // null when editing a saved entry
  proposal: PettyCashProposal | null
  values: Values
  readMessage?: string // why this receipt could not be read at all
}

const BLANK: Values = {
  transaction_id: '',
  txn_date: '',
  payment_to: '',
  payment_from: '',
  remarks: '',
  amount: '',
}

/** Choose one or more receipt files (images or PDFs). */
function ReceiptsPicker({
  files,
  onChange,
  onProblem,
  disabled,
}: {
  files: File[]
  onChange: (files: File[]) => void
  onProblem: (message: string | null) => void
  disabled: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        id={id}
        type="file"
        multiple
        accept={RECEIPT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose receipt"
        disabled={disabled}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? [])
          e.target.value = '' // so choosing the same file again still fires
          if (!chosen.length) return
          const bad = chosen.find((f) => receiptProblem(f))
          const good = chosen.filter((f) => !receiptProblem(f))
          const next = [...files, ...good].slice(0, MAX_FILES)
          onProblem(
            bad
              ? `${bad.name}: ${receiptProblem(bad)}`
              : files.length + good.length > MAX_FILES
                ? `You can add up to ${MAX_FILES} receipts at a time`
                : null,
          )
          onChange(next)
        }}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <Paperclip className="size-4" aria-hidden="true" />
          {files.length ? 'Add more files' : 'Choose receipts'}
        </Button>
      </div>
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1 text-sm text-ink-2">
              <FileText className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate" title={f.name}>
                {f.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                disabled={disabled}
                className="grid size-8 shrink-0 place-items-center rounded-control hover:bg-neutral-soft"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Add entries from receipts (one or several), or edit a saved one. Reading a receipt only PROPOSES
 * values: the employer reviews and corrects each one, and nothing is saved until "Save entry"
 * (ADR 0008).
 */
export function EntryDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry?: PettyCashEntry
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return open ? <EntryForm entry={entry} onOpenChange={onOpenChange} /> : null
}

function EntryForm({
  entry,
  onOpenChange,
}: {
  entry?: PettyCashEntry
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const create = useCreateEntry()
  const update = useUpdateEntry(entry?.id ?? '')
  const [files, setFiles] = useState<File[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // Editing starts at the form; adding starts at "choose the receipts".
  const [items, setItems] = useState<Item[] | null>(
    entry ? [{ file: null, proposal: null, values: fromEntry(entry) }] : null,
  )
  const [index, setIndex] = useState(0)
  const [added, setAdded] = useState(0)
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({})
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const reading = progress !== null
  const item = items?.[index] ?? null
  const proposal = item?.proposal ?? null
  const last = items ? index === items.length - 1 : true

  async function read() {
    if (!files.length) return
    setMessage('')
    const out: Item[] = []
    for (const [i, file] of files.entries()) {
      setProgress({ done: i, total: files.length })
      const result = await extractReceipt(file)
      out.push(
        result.ok
          ? { file, proposal: result.data, values: fromProposal(result.data) }
          : {
              file,
              proposal: null,
              values: BLANK,
              readMessage: result.errors[0]?.message ?? result.message,
            },
      )
    }
    setProgress(null)
    setItems(out)
    setIndex(0)
  }

  function finish(count: number) {
    onOpenChange(false)
    if (count > 0) {
      toast({
        title: count === 1 ? 'Petty cash entry added' : `${count} petty cash entries added`,
        tone: 'success',
      })
    }
  }

  function next(count: number) {
    setErrors({})
    setMessage('')
    if (last) finish(count)
    else setIndex((i) => i + 1)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!item) return
    setSaving(true)
    setMessage('')
    setErrors({})
    const fields = { ...item.values, txn_date: item.values.txn_date || null }
    const result = entry ? await update(fields) : item.file ? await create(item.file, fields) : null
    setSaving(false)
    if (!result) return
    if (result.ok) {
      if (entry) {
        onOpenChange(false)
        toast({ title: 'Entry saved', tone: 'success' })
        return
      }
      setAdded((n) => n + 1)
      next(added + 1)
      return
    }
    const errs: Partial<Record<Fields, string>> = {}
    for (const err of result.errors) errs[err.field as Fields] = err.message
    setErrors(errs)
    setMessage(result.message)
  }

  const field = (key: Fields, extra: { inputMode?: 'decimal'; type?: 'date' } = {}) => (
    <TextField
      label={LABELS[key]}
      value={item?.values[key] ?? ''}
      onChange={(e) =>
        setItems((all) =>
          all
            ? all.map((it, i) =>
                i === index ? { ...it, values: { ...it.values, [key]: e.target.value } } : it,
              )
            : all,
        )
      }
      error={errors[key]}
      required={key === 'amount'}
      helper={proposal && !proposal.found.includes(key) ? 'Not found on the receipt' : undefined}
      {...extra}
    />
  )

  const reviewing = items !== null
  const many = (items?.length ?? 0) > 1
  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={entry ? 'Edit petty cash entry' : 'Add petty cash from receipts'}
      description={
        reviewing
          ? many
            ? `Receipt ${index + 1} of ${items.length}${item?.file ? ` · ${item.file.name}` : ''}. Check every value against the receipt and correct anything that is wrong.`
            : 'Check every value against the receipt and correct anything that is wrong.'
          : `Choose one or more payment receipts: UPI or bank screenshots (PNG, JPG, WebP) or PDFs, up to 5 MB each. Up to ${MAX_FILES} at a time.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => finish(added)}>
            Cancel
          </Button>
          {reviewing ? (
            <>
              {many && (
                <Button variant="secondary" onClick={() => next(added)} disabled={saving}>
                  {last ? 'Skip and finish' : 'Skip'}
                </Button>
              )}
              <Button type="submit" form="petty-cash-form" loading={saving}>
                {many && !last ? 'Save and next' : 'Save entry'}
              </Button>
            </>
          ) : (
            <Button onClick={read} loading={reading} disabled={!files.length}>
              {files.length > 1 ? `Read ${files.length} receipts` : 'Read receipt'}
            </Button>
          )}
        </>
      }
    >
      {!reviewing ? (
        <div className="flex flex-col gap-3">
          {message && <Alert tone="error">{message}</Alert>}
          <ReceiptsPicker
            files={files}
            onChange={setFiles}
            onProblem={setProblem}
            disabled={reading}
          />
          {problem && <p className="text-danger">{problem}</p>}
          {progress && (
            <p role="status" className="text-sm text-ink-2">
              Reading receipt {Math.min(progress.done + 1, progress.total)} of {progress.total}…
            </p>
          )}
          <p className="text-sm text-ink-2">
            We read the text on each receipt to fill in the details. You review them one by one
            before anything is saved.
          </p>
        </div>
      ) : (
        <form id="petty-cash-form" onSubmit={save} className="flex flex-col gap-4" noValidate>
          {item?.readMessage && <Alert tone="error">{item.readMessage}</Alert>}
          {proposal && !proposal.text_read && (
            <Alert tone="warning" title="We couldn't read this receipt">
              {proposal.read_problem ? `${proposal.read_problem}. ` : ''}Fill in the details by
              hand. The receipt file will still be saved with the entry.
            </Alert>
          )}
          {proposal?.duplicate && (
            <Alert tone="warning" title="Possible duplicate">
              An entry with this transaction ID is already saved.
            </Alert>
          )}
          {message && <Alert tone="error">{message}</Alert>}
          {field('transaction_id')}
          {field('txn_date', { type: 'date' })}
          {field('payment_to')}
          {field('payment_from')}
          {field('remarks')}
          {field('amount', { inputMode: 'decimal' })}
        </form>
      )}
    </Modal>
  )
}
