import { useState } from 'react'
import { Alert, Button, Modal, TextField, useToast } from '@/components/ui'
import { useEditCollection, type CollectionDetail } from '@/features/collections/api'

const iso = (d: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? '')
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

type Fields = 'customer_name' | 'phone' | 'amount_due' | 'reference' | 'due_date'

/** Edit one customer. The server does the real validation; its messages are shown under the fields. */
export function EditDialog({
  customer,
  open,
  onOpenChange,
}: {
  customer: CollectionDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return open ? <EditForm customer={customer} onOpenChange={onOpenChange} /> : null
}

function EditForm({
  customer,
  onOpenChange,
}: {
  customer: CollectionDetail
  onOpenChange: (open: boolean) => void
}) {
  const edit = useEditCollection(customer.id)
  const { toast } = useToast()
  const [values, setValues] = useState<Record<Fields, string>>({
    customer_name: customer.customer_name,
    phone: customer.phone ?? '',
    amount_due: customer.amount_due,
    reference: customer.reference ?? '',
    due_date: iso(customer.due_date),
  })
  const [errors, setErrors] = useState<Partial<Record<Fields, string>>>({})
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const field = (
    key: Fields,
    label: string,
    extra: { placeholder?: string; inputMode?: 'tel' | 'decimal' } = {},
  ) => (
    <TextField
      label={label}
      value={values[key]}
      onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
      error={errors[key]}
      required={key === 'customer_name' || key === 'amount_due'}
      {...extra}
    />
  )

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage('')
    const result = await edit({ ...values })
    setSaving(false)
    if (result.ok) {
      onOpenChange(false)
      toast({ title: 'Customer saved', tone: 'success' })
      return
    }
    const next: Partial<Record<Fields, string>> = {}
    for (const err of result.errors) next[err.field as Fields] = err.message
    setErrors(next)
    setMessage(result.message)
  }

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title="Edit customer"
      description="Change the details below. The payment page link stays the same and shows the new details."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="edit-customer-form" loading={saving}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-customer-form" onSubmit={save} className="flex flex-col gap-4" noValidate>
        {message && <Alert tone="error">{message}</Alert>}
        {field('customer_name', 'Customer name')}
        {field('phone', 'Phone number', { placeholder: '98765 43210', inputMode: 'tel' })}
        {field('amount_due', 'Amount due (₹)', { inputMode: 'decimal' })}
        {field('reference', 'Reference')}
        {field('due_date', 'Due date', { placeholder: 'DD/MM/YYYY' })}
      </form>
    </Modal>
  )
}
