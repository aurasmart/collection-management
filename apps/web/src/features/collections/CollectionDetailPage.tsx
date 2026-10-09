import { useState } from 'react'
import {
  Copy,
  ExternalLink,
  Link2,
  MessageCircle,
  MessageSquare,
  Pencil,
  Trash2,
} from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, Card, Skeleton, useToast } from '@/components/ui'
import { DeleteDialog } from '@/features/collections/DeleteDialog'
import { EditDialog } from '@/features/collections/EditDialog'
import { MarkDialog } from '@/features/collections/MarkDialog'
import { StatusPill } from '@/features/collections/StatusPill'
import { useCollection, useCollectionAction } from '@/features/collections/api'
import { copyText } from '@/lib/clipboard'
import { formatPhone, paymentMessage, smsUrl, whatsappUrl } from '@/lib/contact'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { paymentPageLink, routes } from '@/lib/routes'

const linkButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-accent px-4 font-medium text-accent hover:bg-accent-soft'

export function CollectionDetailPage() {
  const { id = '' } = useParams()
  const query = useCollection(id)
  const generate = useCollectionAction(id, 'payment-page')
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const navigate = useNavigate()
  const [marking, setMarking] = useState<'paid' | 'unpaid' | null>(null)

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading customer…</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (query.isError) {
    const notFound = (query.error as { status?: number }).status === 404
    return (
      <Alert tone="error" title={notFound ? 'Customer not found' : "Couldn't load this customer"}>
        <Link to={routes.collections} className="font-medium text-accent hover:underline">
          Back to Collections
        </Link>
      </Alert>
    )
  }

  const c = query.data
  const link = c.payment_token ? paymentPageLink(c.payment_token) : null
  const message = link ? paymentMessage(c.customer_name, c.amount_due, link) : ''
  const paid = c.status === 'PAID'

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to={routes.collections}
          className="inline-flex min-h-11 items-center text-accent hover:underline"
        >
          ← Collections
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{c.customer_name}</h1>
          <StatusPill status={c.status} />
        </div>
      </div>

      <Card aria-label="Customer details">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Item label="Customer">{c.customer_name}</Item>
          <Item label="Phone">{c.phone ? formatPhone(c.phone) : 'No phone number'}</Item>
          <Item label="Amount due">
            <span className="tabular text-xl font-semibold">{formatINR(c.amount_due)}</span>
          </Item>
          <Item label="Reference">{c.reference ?? '—'}</Item>
          <Item label="Due date">{c.due_date ? formatDate(c.due_date) : '—'}</Item>
          <Item label="Status">{paid ? 'Paid' : 'Pending'}</Item>
          <Item label="Payment page">{link ? 'Created' : 'Not created yet'}</Item>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={paid} onClick={() => setEditing(true)}>
            <Pencil className="size-5" aria-hidden="true" />
            Edit
          </Button>
          <Button variant="destructive-outline" onClick={() => setDeleting(true)}>
            <Trash2 className="size-5" aria-hidden="true" />
            Delete
          </Button>
          {paid && <span className="self-center text-sm text-ink-2">Mark as unpaid to edit.</span>}
        </div>
      </Card>

      <Card aria-label="Payment page" className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Payment page</h2>
        {!link ? (
          <>
            <p className="text-ink-2">
              Create a link this customer can open to see the amount and your payment details.
            </p>
            {generate.isError && (
              <Alert tone="error">Couldn't create the page. Please try again.</Alert>
            )}
            <div>
              <Button
                loading={generate.isPending}
                onClick={() =>
                  generate.mutate(undefined, {
                    onSuccess: () => toast({ title: 'Payment page generated', tone: 'success' }),
                  })
                }
              >
                <Link2 className="size-5" aria-hidden="true" />
                Generate Payment Page
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="pay-link" className="text-sm text-ink-2">
                Link to send to the customer
              </label>
              <input
                id="pay-link"
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-h-11 w-full rounded-control border border-field bg-canvas px-3 font-mono text-sm"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={async () =>
                  toast(
                    (await copyText(link))
                      ? { title: 'Link copied', tone: 'success' }
                      : { title: "Couldn't copy. Select the link and copy it.", tone: 'error' },
                  )
                }
              >
                <Copy className="size-5" aria-hidden="true" />
                Copy Link
              </Button>
              {c.phone ? (
                <>
                  <a
                    href={whatsappUrl(c.phone, message)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkButton}
                  >
                    <MessageCircle className="size-5" aria-hidden="true" />
                    Send on WhatsApp
                  </a>
                  <a href={smsUrl(c.phone, message)} className={linkButton}>
                    <MessageSquare className="size-5" aria-hidden="true" />
                    Send SMS
                  </a>
                </>
              ) : (
                <>
                  <Button variant="secondary" disabled aria-describedby="no-phone-note">
                    <MessageCircle className="size-5" aria-hidden="true" />
                    Send on WhatsApp
                  </Button>
                  <Button variant="secondary" disabled aria-describedby="no-phone-note">
                    <MessageSquare className="size-5" aria-hidden="true" />
                    Send SMS
                  </Button>
                  <p id="no-phone-note" className="basis-full text-sm text-ink-2">
                    This customer has no phone number, so WhatsApp and SMS are unavailable. Use Edit
                    to add one.
                  </p>
                </>
              )}
              <a href={link} target="_blank" rel="noopener noreferrer" className={linkButton}>
                <ExternalLink className="size-5" aria-hidden="true" />
                Open page
              </a>
            </div>
            <details className="text-sm text-ink-2">
              <summary className="flex min-h-11 cursor-pointer items-center">
                Message that will be sent
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-control bg-canvas p-3 font-sans">
                {message}
              </pre>
            </details>
          </>
        )}
      </Card>

      <Card aria-label="Payment status" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Payment status</h2>
        {paid ? (
          <>
            <p className="text-ink-2">
              You marked this customer as paid. The customer's link now says "Payment received".
            </p>
            <div>
              <Button variant="secondary" onClick={() => setMarking('unpaid')}>
                Mark as Unpaid
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-ink-2">
              The customer pays you directly. When you have received the money, mark it here.
            </p>
            <div>
              <Button onClick={() => setMarking('paid')}>Mark as Paid</Button>
            </div>
          </>
        )}
      </Card>

      <EditDialog customer={c} open={editing} onOpenChange={setEditing} />
      <DeleteDialog
        customers={[c]}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => void navigate(routes.collections)}
      />
      {marking && (
        <MarkDialog
          id={c.id}
          kind={marking}
          customer={c.customer_name}
          amount={c.amount_due}
          open
          onOpenChange={(o) => !o && setMarking(null)}
        />
      )}
    </div>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
