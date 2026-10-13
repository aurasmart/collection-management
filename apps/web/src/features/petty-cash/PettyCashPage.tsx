import { useEffect, useState } from 'react'
import {
  ArrowUpDown,
  Download,
  ExternalLink,
  Pencil,
  PencilLine,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  Wallet,
} from 'lucide-react'
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  TextField,
  useToast,
} from '@/components/ui'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { EntryDialog } from '@/features/petty-cash/EntryDialog'
import {
  NO_FILTERS,
  PAGE_SIZE,
  exportEntries,
  fetchEntryReceipt,
  useDeleteEntries,
  useDeleteEntry,
  usePettyCash,
  type PettyCashEntry,
  type PettyFilters,
  type Sort,
} from '@/features/petty-cash/api'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { openReceipt, saveFile } from '@/lib/receipt'

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'date_desc', label: 'Date: newest first' },
  { value: 'date_asc', label: 'Date: oldest first' },
  { value: 'amount_desc', label: 'Amount: high to low' },
  { value: 'amount_asc', label: 'Amount: low to high' },
  { value: 'to_asc', label: 'Payment to: A to Z' },
  { value: 'to_desc', label: 'Payment to: Z to A' },
  { value: 'added_desc', label: 'Added: latest' },
  { value: 'added_asc', label: 'Added: earliest' },
]

type PanelKey = 'dateFrom' | 'dateTo' | 'minAmount' | 'maxAmount'
const PANEL_EMPTY: Pick<PettyFilters, PanelKey> = {
  dateFrom: '',
  dateTo: '',
  minAmount: '',
  maxAmount: '',
}
const inputClass = 'min-h-11 w-full rounded-control border border-field bg-surface px-3'

export function PettyCashPage() {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<PettyFilters>(NO_FILTERS)
  const [panelOpen, setPanelOpen] = useState(false)
  const [draft, setDraft] = useState(PANEL_EMPTY)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deletingMany, setDeletingMany] = useState(false)
  const [page, setPage] = useState(0)
  const q = filters.q
  const [adding, setAdding] = useState<'read' | 'manual' | null>(null)
  const [exporting, setExporting] = useState(false)
  const [editing, setEditing] = useState<PettyCashEntry | null>(null)
  const [deleting, setDeleting] = useState<PettyCashEntry | null>(null)
  const query = usePettyCash(filters, page)
  const remove = useDeleteEntry()
  const removeMany = useDeleteEntries()

  const change = (patch: Partial<PettyFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(0)
    setSelected(new Set())
  }
  const panelCount = (['dateFrom', 'dateTo', 'minAmount', 'maxAmount'] as const).filter(
    (k) => filters[k] !== '',
  ).length
  const filtered = q !== '' || panelCount > 0

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() }))
      setPage(0)
      setSelected(new Set())
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  async function exportSheet() {
    setExporting(true)
    try {
      const blob = await exportEntries({ ...filters, q: search.trim() })
      if (!blob) throw new Error('No file')
      saveFile(blob, `petty-cash-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } catch {
      toast({ title: "Couldn't export. Please try again.", tone: 'error' })
    } finally {
      setExporting(false)
    }
  }

  const data = query.data
  const items = data?.items ?? []
  const allOnPage = items.length > 0 && items.every((e) => selected.has(e.id))
  const chosen = items.filter((e) => selected.has(e.id))
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const total = data?.total ?? 0
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Petty Cash</h1>
          <p className="text-ink-2">
            Keep a record of what was paid, with the payment receipt as proof.
          </p>
        </div>
        <AddMenu onPick={setAdding} />
      </div>

      {data && (total > 0 || filtered) && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <TextField
              label="Search"
              className="min-w-60 flex-1"
              placeholder="Transaction ID, name or remarks"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              prefix={<Search className="size-4" />}
            />
            <Button
              variant="secondary"
              aria-expanded={panelOpen}
              aria-controls="petty-filter-panel"
              onClick={() => {
                if (!panelOpen)
                  setDraft({
                    dateFrom: filters.dateFrom,
                    dateTo: filters.dateTo,
                    minAmount: filters.minAmount,
                    maxAmount: filters.maxAmount,
                  })
                setPanelOpen((o) => !o)
              }}
            >
              <SlidersHorizontal className="size-5" aria-hidden="true" />
              Filters{panelCount > 0 && ` (${panelCount})`}
            </Button>
            <label className="flex items-center gap-2 pb-3 text-sm text-ink-2">
              <ArrowUpDown className="size-5" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Sort by</span>
              <select
                aria-label="Sort by"
                value={filters.sort}
                onChange={(e) => change({ sort: e.target.value as Sort })}
                className="min-h-11 rounded-control border border-field bg-surface px-3 text-base text-ink"
              >
                {SORTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {panelOpen && (
            <Card id="petty-filter-panel" aria-label="Filters" className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Date from">
                  <input
                    type="date"
                    className={inputClass}
                    value={draft.dateFrom}
                    onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
                  />
                </Field>
                <Field label="Date to">
                  <input
                    type="date"
                    className={inputClass}
                    value={draft.dateTo}
                    onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
                  />
                </Field>
                <Field label="Amount from (₹)">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    className={inputClass}
                    value={draft.minAmount}
                    onChange={(e) => setDraft({ ...draft, minAmount: e.target.value })}
                  />
                </Field>
                <Field label="Amount up to (₹)">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    className={inputClass}
                    value={draft.maxAmount}
                    onChange={(e) => setDraft({ ...draft, maxAmount: e.target.value })}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    change(draft)
                    setPanelOpen(false)
                  }}
                >
                  Apply filters
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDraft(PANEL_EMPTY)
                    change(PANEL_EMPTY)
                  }}
                >
                  Reset
                </Button>
              </div>
            </Card>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-medium tabular" aria-live="polite">
              Total {formatINR(data.total_amount)}
            </p>
            <Button
              variant="secondary"
              onClick={exportSheet}
              loading={exporting}
              disabled={total === 0}
            >
              <Download className="size-5" aria-hidden="true" />
              Export to Excel
            </Button>
          </div>
        </>
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
          title={filtered ? 'No entries match your search or filters' : 'No petty cash entries yet'}
          description={
            filtered
              ? 'Try a different search, or reset the filters.'
              : 'Read a receipt and we will fill in the details for you to review, or add an entry by hand with the receipt as proof.'
          }
          action={filtered ? undefined : <AddMenu onPick={setAdding} />}
        />
      ) : (
        <>
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-5 accent-accent"
                checked={allOnPage}
                onChange={() =>
                  setSelected(allOnPage ? new Set() : new Set(items.map((e) => e.id)))
                }
              />
              Select all on this page
            </label>
            {chosen.length > 0 && (
              <div className="flex items-center gap-3" role="status">
                <span className="font-medium">{chosen.length} selected</span>
                <Button variant="destructive-outline" onClick={() => setDeletingMany(true)}>
                  <Trash2 className="size-5" aria-hidden="true" />
                  Delete selected
                </Button>
              </div>
            )}
          </div>
          <table className="block w-full md:table">
            <caption className="sr-only">Petty cash entries</caption>
            <thead className="sr-only md:not-sr-only md:table-header-group">
              <tr className="text-left text-sm text-ink-2">
                <th scope="col" className="w-10 px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
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
              {items.map((e) => (
                <tr
                  key={e.id}
                  className={cn(
                    'mb-3 block rounded-card border border-line bg-surface p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-t md:p-0',
                    selected.has(e.id) && 'border-accent bg-accent-soft/40',
                  )}
                >
                  <Cell label="Select">
                    <input
                      type="checkbox"
                      className="size-5 accent-accent"
                      aria-label={`Select ${e.transaction_id ?? e.payment_to ?? 'entry'}`}
                      checked={selected.has(e.id)}
                      onChange={() => toggle(e.id)}
                    />
                  </Cell>
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

      <EntryDialog
        key={adding ?? 'closed'}
        manual={adding === 'manual'}
        open={adding !== null}
        onOpenChange={(o) => {
          if (!o) setAdding(null)
        }}
      />
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
      <ConfirmDialog
        open={deletingMany}
        onOpenChange={setDeletingMany}
        title={`Delete ${chosen.length} petty cash ${chosen.length === 1 ? 'entry' : 'entries'}?`}
        description="The entries and their receipt files are removed. This can't be undone."
        confirmLabel={`Delete ${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}`}
        destructive
        loading={removeMany.isPending}
        onConfirm={() =>
          removeMany.mutate(
            chosen.map((e) => e.id),
            {
              onSuccess: (n) => {
                setDeletingMany(false)
                setSelected(new Set())
                toast({ title: `${n} ${n === 1 ? 'entry' : 'entries'} deleted`, tone: 'success' })
              },
              onError: () =>
                toast({ title: "Couldn't delete. Nothing was removed.", tone: 'error' }),
            },
          )
        }
      />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
      {label}
      {children}
    </label>
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

/** The "+ Add" button: choose between reading receipts and typing an entry by hand. */
function AddMenu({ onPick }: { onPick: (mode: 'read' | 'manual') => void }) {
  const item =
    'flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 outline-none data-[highlighted]:bg-accent-soft'
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button>
          <Plus className="size-5" aria-hidden="true" />
          Add
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-64 rounded-control border border-line bg-surface p-1 shadow-popover"
        >
          <Menu.Item className={item} onSelect={() => onPick('read')}>
            <Upload className="size-4" aria-hidden="true" />
            Import from receipts
          </Menu.Item>
          <Menu.Item className={item} onSelect={() => onPick('manual')}>
            <PencilLine className="size-4" aria-hidden="true" />
            Add manually with receipt
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
