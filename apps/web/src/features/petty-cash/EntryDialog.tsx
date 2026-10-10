import { useState } from 'react'
import { Alert, Button, Modal, TextField, useToast } from '@/components/ui'
import { ReceiptPicker } from '@/features/receipts/ReceiptPicker'
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

/**
 * Add an entry from a receipt, or edit a saved one. Reading a receipt only PROPOSES values: the
 * employer reviews and corrects them, and nothing is saved until "Save entry" (ADR 0008).
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
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [proposal, setProposal] = useState<PettyCashProposal | null>(null)
  // Editing starts at the form; adding starts at "choose the receipt".
  const [values, setValues] = useState<Values | null>(entry ? fromEntry(entry) : null)
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({})
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  async function read() {
    if (!file) return
    setReading(true)
    setMessage('')
    const result = await extractReceipt(file)
    setReading(false)
    if (!result.ok) {
      setMessage(result.errors[0]?.message ?? result.message)
      return
    }
    setProposal(result.data)
    setValues(fromProposal(result.data))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!values) return
    setSaving(true)
    setMessage('')
    setErrors({})
    const fields = { ...values, txn_date: values.txn_date || null }
    const result = entry ? await update(fields) : file ? await create(file, fields) : null
    setSaving(false)
    if (!result) return
    if (result.ok) {
      onOpenChange(false)
      toast({ title: entry ? 'Entry saved' : 'Petty cash entry added', tone: 'success' })
      return
    }
    const next: Partial<Record<Fields, string>> = {}
    for (const err of result.errors) next[err.field as Fields] = err.message
    setErrors(next)
    setMessage(result.message)
  }

  const field = (key: Fields, extra: { inputMode?: 'decimal'; type?: 'date' } = {}) => (
    <TextField
      label={LABELS[key]}
      value={values?.[key] ?? ''}
      onChange={(e) => setValues((v) => (v ? { ...v, [key]: e.target.value } : v))}
      error={errors[key]}
      required={key === 'amount'}
      helper={proposal && !proposal.found.includes(key) ? 'Not found on the receipt' : undefined}
      {...extra}
    />
  )

  const reviewing = values !== null
  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={entry ? 'Edit petty cash entry' : 'Add petty cash from a receipt'}
      description={
        reviewing
          ? 'Check every value against the receipt and correct anything that is wrong.'
          : 'Choose a payment receipt: a UPI or bank screenshot (PNG, JPG, WebP) or a PDF, up to 5 MB.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {reviewing ? (
            <Button type="submit" form="petty-cash-form" loading={saving}>
              Save entry
            </Button>
          ) : (
            <Button onClick={read} loading={reading} disabled={!file}>
              Read receipt
            </Button>
          )}
        </>
      }
    >
      {!reviewing ? (
        <div className="flex flex-col gap-3">
          {message && <Alert tone="error">{message}</Alert>}
          <ReceiptPicker
            file={file}
            onChange={setFile}
            onProblem={setProblem}
            label="Choose receipt"
            disabled={reading}
          />
          {problem && <p className="text-danger">{problem}</p>}
          <p className="text-sm text-ink-2">
            We read the text on the receipt to fill in the details. You review them before anything
            is saved.
          </p>
        </div>
      ) : (
        <form id="petty-cash-form" onSubmit={save} className="flex flex-col gap-4" noValidate>
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
