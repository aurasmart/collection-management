import { useState } from 'react'
import { ConfirmDialog, useToast } from '@/components/ui'
import { useCollectionAction, useUploadReceipt } from '@/features/collections/api'
import { ReceiptPicker } from '@/features/receipts/ReceiptPicker'
import { formatINRCompact } from '@/lib/money'

/**
 * "Mark ₹15,000 as paid for Rahul Sharma?" — the employer's manual confirmation. Nothing is verified.
 * A receipt (UPI screenshot, bank statement PDF, ...) can be attached beside it; it is optional.
 */
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
  const upload = useUploadReceipt(id)
  const [failed, setFailed] = useState(false)
  const [receipt, setReceipt] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const money = formatINRCompact(amount)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        setFailed(false)
        setReceipt(null)
        setProblem(null)
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
        <div className="flex flex-col gap-3">
          {kind === 'paid' && (
            <div className="flex flex-col gap-1">
              <p className="font-medium">Receipt (optional)</p>
              <ReceiptPicker
                file={receipt}
                onChange={setReceipt}
                onProblem={setProblem}
                label="Attach receipt"
                disabled={mutation.isPending}
              />
              <p className="text-sm text-ink-2">
                A UPI screenshot, bank statement or any image or PDF, up to 5 MB. You can also add
                it later.
              </p>
              {problem && <p className="text-danger">{problem}</p>}
            </div>
          )}
          {failed && <p className="text-danger">Couldn't update. Please try again.</p>}
        </div>
      }
      confirmLabel={kind === 'paid' ? 'Mark as Paid' : 'Mark as Unpaid'}
      loading={mutation.isPending || upload.isPending}
      onConfirm={() =>
        mutation.mutate(undefined, {
          onSuccess: async () => {
            const attach = kind === 'paid' ? receipt : null
            let receiptFailed = false
            if (attach) {
              try {
                await upload.mutateAsync(attach)
              } catch {
                receiptFailed = true
              }
            }
            setReceipt(null)
            onOpenChange(false)
            toast({
              title:
                kind === 'paid' ? `${customer} marked as paid` : `${customer} marked as unpaid`,
              description: receiptFailed
                ? "The receipt couldn't be attached. Open the customer to try again."
                : undefined,
              tone: receiptFailed ? 'info' : 'success',
            })
          },
          onError: () => setFailed(true),
        })
      }
    />
  )
}
