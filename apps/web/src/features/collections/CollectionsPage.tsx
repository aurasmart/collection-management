import { useEffect, useState } from 'react'
import { ArrowUpDown, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { Link } from 'react-router'
import { Alert, Button, Card, EmptyState, Skeleton } from '@/components/ui'
import { DeleteDialog } from '@/features/collections/DeleteDialog'
import { MarkDialog } from '@/features/collections/MarkDialog'
import { StatusPill } from '@/features/collections/StatusPill'
import {
  NO_FILTERS,
  PAGE_SIZE,
  useCollections,
  type CollectionFilters,
  type CollectionRow,
  type StatusFilter,
} from '@/features/collections/api'
import { cn } from '@/lib/cn'
import { formatPhone } from '@/lib/contact'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { routes } from '@/lib/routes'

const TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PAID', label: 'Paid' },
]

const SORTS: Array<{ value: CollectionFilters['sort']; label: string }> = [
  { value: 'created_desc', label: 'Newest first' },
  { value: 'created_asc', label: 'Oldest first' },
  { value: 'due_asc', label: 'Due date: soonest' },
  { value: 'due_desc', label: 'Due date: latest' },
  { value: 'amount_desc', label: 'Amount: high to low' },
  { value: 'amount_asc', label: 'Amount: low to high' },
  { value: 'name_asc', label: 'Name: A to Z' },
  { value: 'name_desc', label: 'Name: Z to A' },
]

const inputClass = 'min-h-11 w-full rounded-control border border-field bg-surface px-3'

/** The extra filters (everything except search, status tab, overdue chip and sort). */
type PanelKey = keyof Pick<
  CollectionFilters,
  | 'dueFrom'
  | 'dueTo'
  | 'minAmount'
  | 'maxAmount'
  | 'createdFrom'
  | 'createdTo'
  | 'paymentPage'
  | 'hasPhone'
>

const PANEL_EMPTY: Record<PanelKey, ''> = {
  dueFrom: '',
  dueTo: '',
  minAmount: '',
  maxAmount: '',
  createdFrom: '',
  createdTo: '',
  paymentPage: '',
  hasPhone: '',
}

function chipsFor(f: CollectionFilters): Array<{ key: keyof CollectionFilters; label: string }> {
  const chips: Array<{ key: keyof CollectionFilters; label: string }> = []
  if (f.overdue) chips.push({ key: 'overdue', label: 'Overdue' })
  if (f.dueFrom) chips.push({ key: 'dueFrom', label: `Due from ${formatDate(f.dueFrom)}` })
  if (f.dueTo) chips.push({ key: 'dueTo', label: `Due by ${formatDate(f.dueTo)}` })
  if (f.minAmount) chips.push({ key: 'minAmount', label: `Amount from ${formatINR(f.minAmount)}` })
  if (f.maxAmount) chips.push({ key: 'maxAmount', label: `Amount up to ${formatINR(f.maxAmount)}` })
  if (f.createdFrom)
    chips.push({ key: 'createdFrom', label: `Added from ${formatDate(f.createdFrom)}` })
  if (f.createdTo) chips.push({ key: 'createdTo', label: `Added by ${formatDate(f.createdTo)}` })
  if (f.paymentPage)
    chips.push({
      key: 'paymentPage',
      label: f.paymentPage === 'yes' ? 'Payment page created' : 'No payment page yet',
    })
  if (f.hasPhone)
    chips.push({ key: 'hasPhone', label: f.hasPhone === 'yes' ? 'Has phone' : 'No phone number' })
  return chips
}

export function CollectionsPage() {
  const [filters, setFilters] = useState<CollectionFilters>(NO_FILTERS)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const [draft, setDraft] = useState<Pick<CollectionFilters, PanelKey>>(PANEL_EMPTY)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<CollectionRow[] | null>(null)
  const [marking, setMarking] = useState<{ row: CollectionRow; kind: 'paid' | 'unpaid' } | null>(
    null,
  )

  const change = (patch: Partial<CollectionFilters>) => {
    setFilters((f) => ({ ...f, ...patch }))
    setPage(0)
    setSelected(new Set())
  }

  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() }))
      setPage(0)
    }, 300)
    return () => window.clearTimeout(t)
  }, [search])

  const query = useCollections(filters, page)
  const total = query.data?.total ?? 0
  const items = query.data?.items ?? []
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)
  const chips = chipsFor(filters)
  const filtered = Boolean(filters.q) || filters.status !== 'ALL' || chips.length > 0
  const allOnPage = items.length > 0 && items.every((r) => selected.has(r.id))
  const chosen = items.filter((r) => selected.has(r.id))

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Collections</h1>
        <Link
          to={routes.upload}
          className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-medium text-white hover:bg-accent-hover"
        >
          Import customers
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search
            className="pointer-events-none absolute top-3 left-3 size-5 text-ink-2"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search customers"
            placeholder="Search name, phone or reference"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 w-full rounded-control border border-field bg-surface pr-3 pl-10"
          />
        </div>
        <div role="group" aria-label="Filter by status" className="flex gap-1">
          {TABS.map((t) => (
            <Button
              key={t.value}
              variant={filters.status === t.value ? 'primary' : 'secondary'}
              aria-pressed={filters.status === t.value}
              onClick={() => change({ status: t.value })}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={filters.overdue ? 'primary' : 'secondary'}
          aria-pressed={filters.overdue}
          onClick={() => change({ overdue: !filters.overdue })}
        >
          Overdue
        </Button>
        <Button
          variant="secondary"
          aria-expanded={panelOpen}
          aria-controls="filter-panel"
          onClick={() => {
            if (!panelOpen)
              setDraft({
                dueFrom: filters.dueFrom,
                dueTo: filters.dueTo,
                minAmount: filters.minAmount,
                maxAmount: filters.maxAmount,
                createdFrom: filters.createdFrom,
                createdTo: filters.createdTo,
                paymentPage: filters.paymentPage,
                hasPhone: filters.hasPhone,
              })
            setPanelOpen((o) => !o)
          }}
        >
          <SlidersHorizontal className="size-5" aria-hidden="true" />
          Filters
          {chips.filter((c) => c.key !== 'overdue').length > 0 &&
            ` (${chips.filter((c) => c.key !== 'overdue').length})`}
        </Button>
        <label className="ml-auto flex items-center gap-2 text-sm text-ink-2">
          <ArrowUpDown className="size-5" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Sort by</span>
          <select
            aria-label="Sort by"
            value={filters.sort}
            onChange={(e) => change({ sort: e.target.value as CollectionFilters['sort'] })}
            className="min-h-11 rounded-control border border-field bg-surface px-3 text-base text-ink"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {panelOpen && (
        <Card id="filter-panel" aria-label="Filters" className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Due from">
              <input
                type="date"
                className={inputClass}
                value={draft.dueFrom}
                onChange={(e) => setDraft({ ...draft, dueFrom: e.target.value })}
              />
            </Field>
            <Field label="Due by">
              <input
                type="date"
                className={inputClass}
                value={draft.dueTo}
                onChange={(e) => setDraft({ ...draft, dueTo: e.target.value })}
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
            <Field label="Added from">
              <input
                type="date"
                className={inputClass}
                value={draft.createdFrom}
                onChange={(e) => setDraft({ ...draft, createdFrom: e.target.value })}
              />
            </Field>
            <Field label="Added by">
              <input
                type="date"
                className={inputClass}
                value={draft.createdTo}
                onChange={(e) => setDraft({ ...draft, createdTo: e.target.value })}
              />
            </Field>
            <Field label="Payment page">
              <select
                className={inputClass}
                value={draft.paymentPage}
                onChange={(e) =>
                  setDraft({ ...draft, paymentPage: e.target.value as '' | 'yes' | 'no' })
                }
              >
                <option value="">Any</option>
                <option value="yes">Created</option>
                <option value="no">Not created yet</option>
              </select>
            </Field>
            <Field label="Phone number">
              <select
                className={inputClass}
                value={draft.hasPhone}
                onChange={(e) =>
                  setDraft({ ...draft, hasPhone: e.target.value as '' | 'yes' | 'no' })
                }
              >
                <option value="">Any</option>
                <option value="yes">Has a phone number</option>
                <option value="no">No phone number</option>
              </select>
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
            <Button variant="secondary" onClick={() => setDraft(PANEL_EMPTY)}>
              Reset
            </Button>
          </div>
        </Card>
      )}

      {chips.length > 0 && (
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                aria-label={`Remove filter: ${c.label}`}
                onClick={() =>
                  change({ [c.key]: typeof NO_FILTERS[c.key] === 'boolean' ? false : '' })
                }
                className="inline-flex min-h-9 items-center gap-1 rounded-full bg-accent-soft px-3 text-sm font-medium text-accent hover:bg-accent-soft/70"
              >
                {c.label}
                <X className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
          <li>
            <Button
              variant="tertiary"
              size="sm"
              onClick={() => {
                change({ ...NO_FILTERS, q: filters.q, status: filters.status, sort: filters.sort })
                setPanelOpen(false)
              }}
            >
              Clear all
            </Button>
          </li>
        </ul>
      )}

      {query.isPending && (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading customers…</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      )}

      {query.isError && (
        <Alert
          tone="error"
          title="Couldn't load customers"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Check your connection and try again.
        </Alert>
      )}

      {query.data && total === 0 && (
        <Card>
          {filtered ? (
            <EmptyState
              title="No customers match your search."
              description="Try a different search or filter."
            />
          ) : (
            <EmptyState
              title="No collections yet"
              description="Upload an Excel or CSV file to add your customers."
              action={
                <Link
                  to={routes.upload}
                  className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-medium text-white"
                >
                  Import customers
                </Link>
              }
            />
          )}
        </Card>
      )}

      {items.length > 0 && (
        <>
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-5 accent-accent"
                checked={allOnPage}
                onChange={() =>
                  setSelected(allOnPage ? new Set() : new Set(items.map((r) => r.id)))
                }
              />
              Select all on this page
            </label>
            {chosen.length > 0 && (
              <div className="flex items-center gap-3" role="status">
                <span className="font-medium">{chosen.length} selected</span>
                <Button variant="destructive-outline" onClick={() => setDeleting(chosen)}>
                  <Trash2 className="size-5" aria-hidden="true" />
                  Delete selected
                </Button>
              </div>
            )}
          </div>

          <table className="block w-full md:table">
            <caption className="sr-only">Customers and what they owe</caption>
            <thead className="hidden text-left text-sm text-ink-2 md:table-header-group">
              <tr>
                <th scope="col" className="w-10 border-b border-line px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
                {[
                  'Customer',
                  'Phone',
                  'Amount due',
                  'Due date',
                  'Reference',
                  'Status',
                  'Action',
                ].map((h) => (
                  <th key={h} scope="col" className="border-b border-line px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {items.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    'mb-3 block rounded-card border border-line bg-surface p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-b md:p-0',
                    selected.has(row.id) && 'border-accent bg-accent-soft/40',
                  )}
                >
                  <Cell label="Select">
                    <input
                      type="checkbox"
                      className="size-5 accent-accent"
                      aria-label={`Select ${row.customer_name}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </Cell>
                  <Cell label="Customer" className="font-medium">
                    <Link to={routes.collection(row.id)} className="text-accent hover:underline">
                      {row.customer_name}
                    </Link>
                  </Cell>
                  <Cell label="Phone">{row.phone ? formatPhone(row.phone) : '—'}</Cell>
                  <Cell label="Amount due" className="tabular">
                    {formatINR(row.amount_due)}
                  </Cell>
                  <Cell label="Due date">{row.due_date ? formatDate(row.due_date) : '—'}</Cell>
                  <Cell label="Reference">{row.reference ?? '—'}</Cell>
                  <Cell label="Status">
                    <StatusPill status={row.status} />
                  </Cell>
                  <Cell label="Action">
                    <div className="flex flex-wrap gap-2">
                      <Link
                        to={routes.collection(row.id)}
                        aria-label={`Open ${row.customer_name}`}
                        className="inline-flex min-h-10 items-center rounded-control border border-accent px-3 font-medium text-accent hover:bg-accent-soft"
                      >
                        Open
                      </Link>
                      {row.status === 'PENDING' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Mark paid for ${row.customer_name}`}
                          onClick={() => setMarking({ row, kind: 'paid' })}
                        >
                          Mark paid
                        </Button>
                      )}
                      {row.status === 'PAID' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Mark unpaid for ${row.customer_name}`}
                          onClick={() => setMarking({ row, kind: 'unpaid' })}
                        >
                          Mark unpaid
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        aria-label={`Delete ${row.customer_name}`}
                        onClick={() => setDeleting([row])}
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
                onClick={() => {
                  setPage((p) => p - 1)
                  setSelected(new Set())
                }}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={to >= total}
                onClick={() => {
                  setPage((p) => p + 1)
                  setSelected(new Set())
                }}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {marking && (
        <MarkDialog
          id={marking.row.id}
          kind={marking.kind}
          customer={marking.row.customer_name}
          amount={marking.row.amount_due}
          open
          onOpenChange={(o) => !o && setMarking(null)}
        />
      )}
      {deleting && (
        <DeleteDialog
          customers={deleting}
          open
          onOpenChange={(o) => !o && setDeleting(null)}
          onDeleted={() => setSelected(new Set())}
        />
      )}
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

/** One markup for desktop (table cell) and phones (stacked card with a label). */
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
      className={cn(
        'flex items-start justify-between gap-3 py-1 before:text-sm before:text-ink-2 before:content-[attr(data-label)] md:table-cell md:px-3 md:py-3 md:before:hidden',
        className,
      )}
    >
      <div className="text-right md:text-left">{children}</div>
    </td>
  )
}
