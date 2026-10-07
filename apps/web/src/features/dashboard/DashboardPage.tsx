import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Alert, Button, Card, EmptyState, Skeleton } from '@/components/ui'
import { useAuth } from '@/features/auth/AuthProvider'
import { StatusPill } from '@/features/collections/StatusPill'
import { api } from '@/lib/api'
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

export function DashboardPage() {
  const query = useDashboard()
  const d = query.data

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

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

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Total Outstanding" value={d && formatINR(d.total_outstanding)} hero />
        <Metric label="Pending Customers" value={d && String(d.pending_customers)} />
        <Metric label="Paid" value={d && formatINR(d.paid_amount)} />
        <Metric label="Customers" value={d && String(d.customers)} />
      </section>

      <Card aria-labelledby="recent-title">
        <h2 id="recent-title" className="mb-3 text-lg font-semibold">
          Recent Collections
        </h2>
        {!d && !query.isError && <Skeleton className="h-32 w-full" />}
        {d && d.recent.length === 0 && (
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
        )}
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
                  <td className="py-3">
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
      </Card>
    </div>
  )
}

function Metric({ label, value, hero = false }: { label: string; value?: string; hero?: boolean }) {
  return (
    <Card className={hero ? 'col-span-2 lg:col-span-1' : ''}>
      <p className="text-sm text-ink-2">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-2 h-8 w-28" />
      ) : (
        <p className={`tabular font-semibold ${hero ? 'text-3xl' : 'text-2xl'}`}>{value}</p>
      )}
    </Card>
  )
}
