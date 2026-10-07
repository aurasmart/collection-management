import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { components } from '@collections/api-types'
import { Check, Copy } from 'lucide-react'
import { useParams } from 'react-router'
import { Alert, Button, Skeleton } from '@/components/ui'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { env } from '@/lib/env'
import { formatINR } from '@/lib/money'

/**
 * The customer's page: no login, no account. It only SHOWS the company's payment details next to the
 * amount. Opening it, copying a value, or scanning the QR does not pay or change anything.
 */
export function PayPage() {
  const { token = '' } = useParams()
  const query = useQuery({
    queryKey: ['public-pay', token],
    retry: false,
    queryFn: async () => {
      const { data, response } = await api.GET('/api/v1/public/pay/{token}', {
        params: { path: { token } },
      })
      if (!data) throw Object.assign(new Error('unavailable'), { status: response.status })
      return data
    },
  })

  const company = query.data?.company_name
  useEffect(() => {
    document.title = company ? `Payment request — ${company}` : 'Payment request'
    return () => {
      document.title = 'Collections'
    }
  }, [company])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col gap-4 px-4 py-6">
      {query.isPending && (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading payment details…</span>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}
      {query.isError && (
        <Unavailable
          status={(query.error as { status?: number }).status}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data?.state === 'PAID' && (
        <>
          <p className="text-center text-lg font-semibold">{query.data.company_name}</p>
          <div className="rounded-card border border-success bg-success-soft p-6 text-center">
            <Check className="mx-auto size-10 text-success" aria-hidden="true" />
            <h1 className="mt-2 text-2xl font-semibold">Payment received</h1>
            <p className="mt-1 text-ink-2">Thank you, {query.data.customer_name}.</p>
          </div>
        </>
      )}
      {query.data?.state === 'PENDING' && <Instructions page={query.data} token={token} />}
    </main>
  )
}

function Unavailable({ status, onRetry }: { status?: number; onRetry: () => void }) {
  if (status === 404) {
    return (
      <div className="rounded-card border border-line bg-surface p-6 text-center">
        <h1 className="text-xl font-semibold">This payment page is unavailable.</h1>
        <p className="mt-2 text-ink-2">
          Please check the link, or contact the person who sent it to you.
        </p>
      </div>
    )
  }
  if (status === 429) {
    return (
      <Alert tone="warning" title="Please wait a moment">
        Too many requests. Wait a minute and try again.
      </Alert>
    )
  }
  return (
    <Alert
      tone="error"
      title="We can't load this page right now"
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      Please try again in a moment.
    </Alert>
  )
}

type Page = components['schemas']['PublicPage']

function Instructions({ page, token }: { page: Page; token: string }) {
  const hasUpi = Boolean(page.upi_id || page.upi_number)
  const none = !hasUpi && !page.has_qr && !page.bank
  return (
    <>
      <header className="text-center">
        <p className="text-lg font-semibold">{page.company_name}</p>
        <p className="text-sm text-ink-2">Payment request</p>
      </header>

      <section
        aria-label="Amount"
        className="rounded-card border border-line bg-surface p-5 text-center"
      >
        <p className="text-sm text-ink-2">Amount due</p>
        <h1 className="tabular text-4xl font-semibold">{formatINR(page.amount_due ?? 0)}</h1>
        <p className="mt-2">
          <span className="text-ink-2">For: </span>
          {page.customer_name}
        </p>
        {page.reference && (
          <p className="text-sm text-ink-2">
            Reference: <span className="text-ink">{page.reference}</span>
          </p>
        )}
      </section>

      {none && (
        <Alert tone="info">
          {page.company_name} hasn't added payment details yet. Please contact them to pay.
        </Alert>
      )}

      {hasUpi && (
        <Method title="UPI">
          {page.upi_id && <Copyable label="UPI ID" value={page.upi_id} copyLabel="Copy UPI ID" />}
          {page.upi_number && (
            <Copyable label="UPI number" value={page.upi_number} copyLabel="Copy UPI number" />
          )}
        </Method>
      )}

      {page.has_qr && (
        <Method title="QR code">
          <img
            src={`${env.apiUrl}/api/v1/public/pay/${encodeURIComponent(token)}/qr`}
            alt={`${page.company_name} payment QR code`}
            className="mx-auto size-64 max-w-full object-contain"
          />
          <p className="text-center text-sm text-ink-2">
            Scan with any UPI app and enter the amount shown above.
          </p>
        </Method>
      )}

      {page.bank && (
        <Method title="Bank transfer">
          {page.bank.bank_name && <Row label="Bank" value={page.bank.bank_name} />}
          {page.bank.account_name && <Row label="Account holder" value={page.bank.account_name} />}
          <Copyable
            label="Account number"
            value={page.bank.account_number}
            copyLabel="Copy account number"
          />
          {page.bank.ifsc && <Copyable label="IFSC" value={page.bank.ifsc} copyLabel="Copy IFSC" />}
        </Method>
      )}

      <p className="rounded-card bg-neutral-soft p-4 text-sm text-ink-2">
        Please make the payment using any of the methods above. Payment is made directly to the
        company. This page does not process or collect payment.
      </p>
    </>
  )
}

function Method({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4"
    >
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-2">{label}</span>
      <span className="text-right break-words">{value}</span>
    </div>
  )
}

function Copyable({
  label,
  value,
  copyLabel,
}: {
  label: string
  value: string
  copyLabel: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-ink-2">{label}</p>
        <p className="font-mono break-all">{value}</p>
      </div>
      <Button
        variant="secondary"
        aria-label={copyLabel}
        onClick={async () => {
          if (await copyText(value)) {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
          }
        }}
      >
        {copied ? (
          <Check className="size-5" aria-hidden="true" />
        ) : (
          <Copy className="size-5" aria-hidden="true" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
