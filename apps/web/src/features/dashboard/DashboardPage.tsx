import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Upload,
  Users,
} from 'lucide-react'
import { Link } from 'react-router'
import { Alert, Badge, Button, EmptyState, Skeleton } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { useMe } from '@/features/auth/useMe'
import { StatusPill } from '@/features/collections/StatusPill'
import { useCompanyProfile } from '@/features/settings/companyApi'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { routes } from '@/lib/routes'

function useDashboard() {
  const { status } = useAuth()
  return useQuery({
    queryKey: ['dashboard'],
    enabled: status === 'signed-in',
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/dashboard')
      if (error || !data) throw new Error('Could not load the dashboard')
      return data
    },
  })
}

type Dashboard = NonNullable<ReturnType<typeof useDashboard>['data']>

function greeting(now = new Date()): string {
  const h = now.getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const today = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

/** Share of the money owed that has been collected, 0-100 (whole numbers). */
function collectedPercent(d: Dashboard): number {
  const paid = Number(d.paid_amount)
  const total = paid + Number(d.total_outstanding)
  return total > 0 ? Math.round((paid / total) * 100) : 0
}

export function DashboardPage() {
  const query = useDashboard()
  const me = useMe()
  const company = useCompanyProfile()
  const d = query.data
  const name = company.data?.display_name ?? me.data?.name

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-ink-2">
            {greeting()}
            {name ? `, ${name}` : ''}. {today.format(new Date())}
          </p>
        </div>
        <Link
          to={routes.upload}
          className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 font-medium text-white shadow-sm hover:bg-accent-hover"
        >
          <Upload className="size-5" aria-hidden="true" />
          Import customers
        </Link>
      </div>

      {query.isError && (
        <Alert
          tone="error"
          title="Couldn't load your dashboard"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Check your connection and try again.
        </Alert>
      )}

      <section aria-label="Totals" className="flex flex-col gap-4">
        <Hero d={d} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric
            icon={<Users className="size-5" aria-hidden="true" />}
            tone="warning"
            label="Pending Customers"
            value={d && String(d.pending_customers)}
          />
          <Metric
            icon={<CheckCircle2 className="size-5" aria-hidden="true" />}
            tone="success"
            label="Paid"
            value={d && formatINR(d.paid_amount)}
            note={
              d && `${d.paid_customers} ${d.paid_customers === 1 ? 'customer' : 'customers'} paid`
            }
          />
          <Metric
            icon={<Users className="size-5" aria-hidden="true" />}
            tone="accent"
            label="Customers"
            value={d && String(d.customers)}
            note={d && `${d.pending_customers} pending · ${d.paid_customers} paid`}
          />
        </div>
      </section>

      <section aria-label="Insights" className="grid gap-4 sm:grid-cols-2">
        <Insight
          to={`${routes.collections}?overdue=1`}
          icon={<AlertTriangle className="size-5" aria-hidden="true" />}
          tone="danger"
          label="Overdue"
          amount={d?.overdue_amount}
          count={d?.overdue_customers}
          empty="Nothing is overdue."
        />
        <Insight
          to={routes.collections}
          icon={<CalendarClock className="size-5" aria-hidden="true" />}
          tone="info"
          label="Due in the next 7 days"
          amount={d?.due_soon_amount}
          count={d?.due_soon_customers}
          empty="Nothing due this week."
        />
      </section>

      {d && d.recent.length === 0 ? (
        <Panel title="Recent Collections" id="recent-title">
          <EmptyState
            title="No collections yet"
            description="Upload an Excel or CSV file to add the customers who owe you money."
            action={
              <Link
                to={routes.upload}
                className="inline-flex min-h-11 items-center rounded-control bg-accent px-4 font-medium text-white"
              >
                Import customers
              </Link>
            }
          />
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Biggest outstanding" id="top-title" action={{ to: routes.collections }}>
            {!d && !query.isError && <ListSkeleton />}
            {d && d.top_outstanding.length === 0 && (
              <p className="py-6 text-center text-ink-2">Everyone has paid. Nice work.</p>
            )}
            {d && d.top_outstanding.length > 0 && (
              <ol className="divide-y divide-line">
                {d.top_outstanding.map((r, i) => (
                  <li key={r.id} className="flex items-center gap-3 py-3">
                    <span
                      aria-hidden="true"
                      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent"
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        to={routes.collection(r.id)}
                        className="block truncate font-medium text-accent hover:underline"
                      >
                        {r.customer_name}
                      </Link>
                      <DueNote date={r.due_date} />
                    </div>
                    <span className="tabular font-semibold">{formatINR(r.amount_due)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Recent Collections" id="recent-title" action={{ to: routes.collections }}>
            {!d && !query.isError && <ListSkeleton />}
            {d && d.recent.length > 0 && (
              <table className="w-full text-left">
                <thead className="text-sm text-ink-2">
                  <tr>
                    <th scope="col" className="py-2 font-medium">
                      Customer
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Amount
                    </th>
                    <th scope="col" className="py-2 pl-3 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.recent.map((r) => (
                    <tr key={r.id} className="border-t border-line">
                      <td className="py-3 pr-3">
                        <Link
                          to={routes.collection(r.id)}
                          className="font-medium text-accent hover:underline"
                        >
                          {r.customer_name}
                        </Link>
                      </td>
                      <td className="tabular py-3 text-right">{formatINR(r.amount_due)}</td>
                      <td className="py-3 pl-3">
                        <StatusPill status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
    </div>
  )
}

/** The headline number: what is still owed, with how much has already been collected. */
function Hero({ d }: { d?: Dashboard }) {
  const pct = d ? collectedPercent(d) : 0
  return (
    <div className="relative overflow-hidden rounded-card bg-linear-to-br from-[#172554] via-[#1e3a8a] to-accent p-6 text-white shadow-popover">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-white/10"
      />
      <div className="relative flex flex-wrap items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white/80">Total Outstanding</p>
          {d ? (
            <p className="tabular mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">
              {formatINR(d.total_outstanding)}
            </p>
          ) : (
            <Skeleton className="mt-2 h-12 w-56 bg-white/20" />
          )}
          <p className="mt-2 text-sm text-white/80">
            {d
              ? d.pending_customers === 0
                ? 'No pending customers.'
                : `Still to collect from ${d.pending_customers} ${d.pending_customers === 1 ? 'customer' : 'customers'}.`
              : ' '}
          </p>
        </div>
        <Ring percent={pct} loading={!d} />
      </div>
    </div>
  )
}

function Ring({ percent, loading }: { percent: number; loading: boolean }) {
  const r = 42
  const c = 2 * Math.PI * r
  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox="0 0 100 100"
        className="size-24 shrink-0 -rotate-90"
        role="img"
        aria-label={loading ? 'Collected so far' : `${percent}% of the money owed is collected`}
      >
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgb(255 255 255 / 0.2)" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="white"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - percent / 100)}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <div>
        <p className="tabular text-3xl font-semibold">{loading ? '—' : `${percent}%`}</p>
        <p className="text-sm text-white/80">collected</p>
      </div>
    </div>
  )
}

const toneIcon = {
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
} as const

function Metric({
  icon,
  tone,
  label,
  value,
  note,
  className,
}: {
  icon: ReactNode
  tone: keyof typeof toneIcon
  label: string
  value?: string
  note?: string
  className?: string
}) {
  return (
    <div
      className={cn('rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5', className)}
    >
      <div className="flex items-center gap-3">
        <span className={cn('grid size-9 place-items-center rounded-full', toneIcon[tone])}>
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-sm text-ink-2">{label}</p>
          {value === undefined ? (
            <Skeleton className="mt-1 h-8 w-28" />
          ) : (
            <p className="tabular text-2xl font-semibold">{value}</p>
          )}
        </div>
      </div>
      {note && <p className="mt-2 text-sm text-ink-2">{note}</p>}
    </div>
  )
}

function Insight({
  to,
  icon,
  tone,
  label,
  amount,
  count,
  empty,
}: {
  to: string
  icon: ReactNode
  tone: keyof typeof toneIcon
  label: string
  amount?: string
  count?: number
  empty: string
}) {
  const loading = amount === undefined || count === undefined
  return (
    <Link
      to={to}
      className="group flex items-center gap-4 rounded-card border border-line bg-surface p-4 shadow-sm transition-shadow hover:shadow-popover sm:p-5"
    >
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-full', toneIcon[tone])}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-2">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-32" />
        ) : count === 0 ? (
          <p className="text-ink-2">{empty}</p>
        ) : (
          <p>
            <span className="tabular text-xl font-semibold">{formatINR(amount)}</span>
            <span className="ml-2 text-sm text-ink-2">
              {count} {count === 1 ? 'customer' : 'customers'}
            </span>
          </p>
        )}
      </div>
      <ChevronRight
        className="size-5 shrink-0 text-ink-2 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  )
}

function Panel({
  title,
  id,
  action,
  children,
}: {
  title: string
  id: string
  action?: { to: string }
  children: ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-card border border-line bg-surface p-4 shadow-sm sm:p-6"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {action && (
          <Link
            to={action.to}
            className="inline-flex min-h-9 items-center text-sm font-medium text-accent hover:underline"
          >
            View all
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

function DueNote({ date }: { date: string | null | undefined }) {
  if (!date) return <p className="text-sm text-ink-2">No due date</p>
  const overdue = date < new Date().toISOString().slice(0, 10)
  return overdue ? (
    <Badge tone="danger">Overdue · {formatDate(date)}</Badge>
  ) : (
    <p className="text-sm text-ink-2">Due {formatDate(date)}</p>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}
