import { useState } from 'react'
import { ConfirmDialog, useToast } from '@/components/ui'
import { useDeleteCollections, type CollectionRow } from '@/features/collections/api'

/** "Delete 3 customers?" Used from the list (one or several) and from the customer page. */
export function DeleteDialog({
  customers,
  open,
  onOpenChange,
  onDeleted,
}: {
  customers: Array<Pick<CollectionRow, 'id' | 'customer_name' | 'status'>>
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const { toast } = useToast()
  const del = useDeleteCollections()
  const [failed, setFailed] = useState(false)
  const n = customers.length
  const paid = customers.filter((c) => c.status === 'PAID').length
  const name = customers[0]?.customer_name ?? ''
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        setFailed(false)
        onOpenChange(o)
      }}
      title={n === 1 ? `Delete ${name}?` : `Delete ${n} customers?`}
      description={
        n === 1
          ? "This customer's payment link stops working. This can't be undone."
          : "Their payment links stop working. This can't be undone."
      }
      consequences={
        <>
          {paid > 0 && (
            <p className="text-warning">
              {paid === 1
                ? '1 of them is marked Paid. Its paid record will also be removed.'
                : `${paid} of them are marked Paid. Their paid records will also be removed.`}
            </p>
          )}
          {failed && (
            <p className="text-danger">Couldn't delete. Nothing was removed. Try again.</p>
          )}
        </>
      }
      confirmLabel={n === 1 ? 'Delete customer' : `Delete ${n} customers`}
      destructive
      loading={del.isPending}
      onConfirm={() =>
        del.mutate(
          customers.map((c) => c.id),
          {
            onSuccess: () => {
              onOpenChange(false)
              toast({
                title: n === 1 ? `${name} deleted` : `${n} customers deleted`,
                tone: 'success',
              })
              onDeleted?.()
            },
            onError: () => setFailed(true),
          },
        )
      }
    />
  )
}
