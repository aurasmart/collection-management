import { useEffect, useState } from 'react'
import { ExternalLink, Pencil, Plus, Search, Trash2, Wallet } from 'lucide-react'
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  TextField,
  useToast,
} from '@/components/ui'
import { EntryDialog } from '@/features/petty-cash/EntryDialog'
import {
  PAGE_SIZE,
  fetchEntryReceipt,
  useDeleteEntry,
  usePettyCash,
  type PettyCashEntry,
} from '@/features/petty-cash/api'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { openReceipt } from '@/lib/receipt'

export function PettyCashPage() {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<PettyCashEntry | null>(null)
  const [deleting, setDeleting] = useState<PettyCashEntry | null>(null)
  const query = usePettyCash(q, page)
  const remove = useDeleteEntry()

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const data = query.data
  const total = data?.total ?? 0
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Petty Cash</h1>
          <p className="text-ink-2">Upload a payment receipt and keep a record of what was paid.</p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="size-5" aria-hidden="true" />
          Add from receipt
        </Button>
      </div>

      {data && (total > 0 || q) && (
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            label="Search"
            className="min-w-60 flex-1"
            placeholder="Transaction ID, name or remarks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<Search className="size-4" />}
          />
          <p className="pb-3 font-medium tabular" aria-live="polite">
            Total {formatINR(data.total_amount)}
          </p>
        </div>
      )}

      {query.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading petty cash…</span>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : query.isError ? (
        <Alert
          tone="error"
          title="Couldn't load petty cash"
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      ) : total === 0 ? (
        <EmptyState
          icon={<Wallet className="size-10" aria-hidden="true" />}
          title={q ? 'No entries match your search' : 'No petty cash entries yet'}
          description={
            q
              ? 'Try a different transaction ID, name or remark.'
              : 'Add a receipt and we will fill in the transaction details for you to review.'
          }
          action={
            q ? undefined : (
              <Button onClick={() => setAdding(true)}>
                <Plus className="size-5" aria-hidden="true" />
                Add from receipt
              </Button>
            )
          }
        />
      ) : (
        <>
          <table className="block w-full md:table">
            <caption className="sr-only">Petty cash entries</caption>
            <thead className="sr-only md:not-sr-only md:table-header-group">
              <tr className="text-left text-sm text-ink-2">
                {['Date', 'Payment to', 'Payment from', 'Transaction ID', 'Remarks', 'Amount'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ),
                )}
                <th scope="col" className="px-3 py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {data!.items.map((e) => (
                <tr
                  key={e.id}
                  className="mb-3 block rounded-card border border-line bg-surface p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-t md:p-0"
                >
                  <Cell label="Date">{e.txn_date ? formatDate(e.txn_date) : '—'}</Cell>
                  <Cell label="Payment to" className="font-medium">
                    {e.payment_to ?? '—'}
                  </Cell>
                  <Cell label="Payment from">{e.payment_from ?? '—'}</Cell>
                  <Cell label="Transaction ID">{e.transaction_id ?? '—'}</Cell>
                  <Cell label="Remarks">{e.remarks ?? '—'}</Cell>
                  <Cell label="Amount" className="tabular">
                    {formatINR(e.amount)}
                  </Cell>
                  <Cell label="Actions">
                    <div className="flex flex-nowrap items-center gap-2 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`View receipt for ${e.transaction_id ?? e.payment_to ?? 'entry'}`}
                        onClick={async () => {
                          if (!(await openReceipt(() => fetchEntryReceipt(e.id))))
                            toast({ title: "Couldn't open the receipt", tone: 'error' })
                        }}
                      >
                        <ExternalLink className="size-4" aria-hidden="true" />
                        Receipt
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Edit ${e.transaction_id ?? e.payment_to ?? 'entry'}`}
                        onClick={() => setEditing(e)}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        aria-label={`Delete ${e.transaction_id ?? e.payment_to ?? 'entry'}`}
                        onClick={() => setDeleting(e)}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                        Delete
                      </Button>
                    </div>
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3">
            <p className="text-ink-2" aria-live="polite">
              Showing {from}–{to} of {total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={to >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <EntryDialog open={adding} onOpenChange={setAdding} />
      {editing && (
        <EntryDialog
          entry={editing}
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null)
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this petty cash entry?"
        description="The entry and its receipt file are removed. This can't be undone."
        confirmLabel="Delete entry"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null)
              toast({ title: 'Entry deleted', tone: 'success' })
            },
            onError: () => toast({ title: "Couldn't delete the entry", tone: 'error' }),
          })
        }
      />
    </div>
  )
}

function Cell({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <td
      data-label={label}
      className={`flex items-start justify-between gap-3 py-1 before:text-sm before:text-ink-2 before:content-[attr(data-label)] md:table-cell md:px-3 md:py-3 md:before:hidden ${className ?? ''}`}
    >
      {children}
    </td>
  )
}
