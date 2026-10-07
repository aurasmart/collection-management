import { useState } from 'react'
import { ConfirmDialog, useToast } from '@/components/ui'
import { useCollectionAction } from '@/features/collections/api'
import { formatINRCompact } from '@/lib/money'

/** "Mark ₹15,000 as paid for Rahul Sharma?" — the employer's manual confirmation. Nothing is verified. */
export function MarkDialog({
  id,
  kind,
  customer,
  amount,
  open,
  onOpenChange,
}: {
  id: string
  kind: 'paid' | 'unpaid'
  customer: string
  amount: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { toast } = useToast()
  const paid = useCollectionAction(id, 'mark-paid')
  const unpaid = useCollectionAction(id, 'mark-unpaid')
  const mutation = kind === 'paid' ? paid : unpaid
  const [failed, setFailed] = useState(false)
  const money = formatINRCompact(amount)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        setFailed(false)
        onOpenChange(o)
      }}
      title={
        kind === 'paid' ? `Mark ${money} as paid for ${customer}?` : `Mark ${customer} as unpaid?`
      }
      description={
        kind === 'paid'
          ? 'Only do this once you have received the money. Nothing is checked automatically.'
          : 'This just corrects the status back to Pending.'
      }
      consequences={
        failed ? <p className="text-danger">Couldn't update. Please try again.</p> : undefined
      }
      confirmLabel={kind === 'paid' ? 'Mark as Paid' : 'Mark as Unpaid'}
      loading={mutation.isPending}
      onConfirm={() =>
        mutation.mutate(undefined, {
          onSuccess: () => {
            onOpenChange(false)
            toast({
              title:
                kind === 'paid' ? `${customer} marked as paid` : `${customer} marked as unpaid`,
              tone: 'success',
            })
          },
          onError: () => setFailed(true),
        })
      }
    />
  )
}
