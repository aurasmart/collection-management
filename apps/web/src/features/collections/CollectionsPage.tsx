import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Link } from 'react-router'
import { Alert, Button, Card, EmptyState, Skeleton } from '@/components/ui'
import { MarkDialog } from '@/features/collections/MarkDialog'
import { StatusPill } from '@/features/collections/StatusPill'
import {
  PAGE_SIZE,
  useCollections,
  type CollectionRow,
  type StatusFilter,
} from '@/features/collections/api'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { routes } from '@/lib/routes'

const TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'PAID', label: 'Paid' },
]

export function CollectionsPage() {
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [marking, setMarking] = useState<CollectionRow | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => {
      setQ(search.trim())
      setPage(0)
    }, 300)
    return () => window.clearTimeout(t)
  }, [search])

  const query = useCollections(status, q, page)
  const total = query.data?.total ?? 0
  const items = query.data?.items ?? []
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Collections</h1>
        <Link
          to={routes.upload}
          className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-medium text-white hover:bg-accent-hover"
        >
          Upload customers
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
              variant={status === t.value ? 'primary' : 'secondary'}
              aria-pressed={status === t.value}
              onClick={() => {
                setStatus(t.value)
                setPage(0)
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

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
          {q || status !== 'ALL' ? (
            <EmptyState
              title="No customers match"
              description="Try a different search or filter."
            />
          ) : (
            <EmptyState
              title="No customers yet"
              description="Upload an Excel or CSV file to add your customers."
              action={
                <Link
                  to={routes.upload}
                  className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-medium text-white"
                >
                  Upload customers
                </Link>
              }
            />
          )}
        </Card>
      )}

      {items.length > 0 && (
        <>
          <table className="block w-full md:table">
            <caption className="sr-only">Customers and what they owe</caption>
            <thead className="hidden text-left text-sm text-ink-2 md:table-header-group">
              <tr>
                {['Customer', 'Phone', 'Amount due', 'Due date', 'Status', 'Action'].map((h) => (
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
                  className="mb-3 block rounded-card border border-line bg-surface p-3 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-b md:p-0"
                >
                  <Cell label="Customer" className="font-medium">
                    <Link to={routes.collection(row.id)} className="text-accent hover:underline">
                      {row.customer_name}
                    </Link>
                    {row.reference && (
                      <span className="block text-sm font-normal text-ink-2">{row.reference}</span>
                    )}
                  </Cell>
                  <Cell label="Phone">{row.phone ?? '—'}</Cell>
                  <Cell label="Amount due" className="tabular">
                    {formatINR(row.amount_due)}
                  </Cell>
                  <Cell label="Due date">{row.due_date ? formatDate(row.due_date) : '—'}</Cell>
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
                          aria-label={`Mark ${row.customer_name} as paid`}
                          onClick={() => setMarking(row)}
                        >
                          Mark paid
                        </Button>
                      )}
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
                onClick={() => setPage((p) => p - 1)}
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

      {marking && (
        <MarkDialog
          id={marking.id}
          kind="paid"
          customer={marking.customer_name}
          amount={marking.amount_due}
          open
          onOpenChange={(o) => !o && setMarking(null)}
        />
      )}
    </div>
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
