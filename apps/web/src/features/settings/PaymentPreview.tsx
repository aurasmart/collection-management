import { Badge } from '@/components/ui'
import { formatINR } from '@/lib/money'
import type { FormValues } from '@/features/settings/schema'

/**
 * "How this will look to customers" (Stage 2 S10). It is a PREVIEW of the instructions only: no payment
 * request, token or link exists here, nothing is sent and nothing is saved. Sample data is clearly labelled.
 * The same component will back the request preview in Phase 4.
 */
export function PaymentPreview({ values, qrUrl }: { values: FormValues; qrUrl: string | null }) {
  const showUpi = values.upi_enabled && values.upi_id.trim() !== ''
  const showUpiNumber = values.upi_number_enabled && values.upi_number.trim() !== ''
  const showQr = values.qr_enabled && qrUrl !== null
  const showBank =
    values.bank_enabled &&
    values.bank_name.trim() !== '' &&
    values.account_number.trim() !== '' &&
    values.ifsc.trim() !== ''
  const anything = showUpi || showUpiNumber || showQr || showBank
  const name = values.display_name.trim() || 'Your business name'

  return (
    <section aria-labelledby="preview-title" className="rounded-card border border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-line p-4">
        <h2 id="preview-title" className="text-lg font-semibold">
          How this will look to customers
        </h2>
        <Badge tone="info">Preview</Badge>
      </header>
      <p className="border-b border-line bg-info-soft px-4 py-2 text-sm text-info">
        This is a sample, not a real payment request. No link is created and nothing is sent.
      </p>
      <div
        className="mx-auto flex max-w-[480px] flex-col gap-3 bg-canvas p-4"
        data-testid="preview-body"
      >
        <p className="text-center font-semibold">{name}</p>
        <p className="text-center text-sm text-ink-2">Payment request</p>
        <div className="rounded-card border border-line bg-surface p-4 text-center">
          <p className="text-sm text-ink-2">Amount requested (sample)</p>
          <p className="tabular text-3xl font-semibold">{formatINR(10000)}</p>
          <p className="text-ink-2">For: Sample Customer</p>
          <p className="text-sm text-ink-2">Reference: INV-0001</p>
        </div>

        {!anything && (
          <p className="rounded-card border border-dashed border-line p-4 text-center text-ink-2">
            Turn on a payment method to see it here.
          </p>
        )}
        {showUpi && (
          <Method title="UPI">
            <Row label="UPI ID" value={values.upi_id.trim()} mono />
          </Method>
        )}
        {showUpiNumber && (
          <Method title="UPI number">
            <Row label="Number" value={values.upi_number.trim()} mono />
          </Method>
        )}
        {showQr && (
          <Method title="QR code">
            <img
              src={qrUrl}
              alt={`UPI QR code for ${name}`}
              className="mx-auto size-60 max-w-full object-contain"
            />
            <p className="text-center text-sm text-ink-2">Scan with any UPI app</p>
          </Method>
        )}
        {showBank && (
          <Method title="Bank transfer">
            {values.account_name.trim() && (
              <Row label="Account name" value={values.account_name.trim()} />
            )}
            <Row label="Bank" value={values.bank_name.trim()} />
            <Row label="Account number" value={values.account_number.trim()} mono />
            <Row label="IFSC" value={values.ifsc.trim().toUpperCase()} mono />
          </Method>
        )}
        <p className="rounded-card bg-neutral-soft p-3 text-sm text-ink-2">
          This page does not collect payment. Pay using one of the methods above in your own bank or
          UPI app. {name} will confirm once they receive it.
        </p>
      </div>
    </section>
  )
}

function Method({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-ink-2">{label}</span>
      <span className={mono ? 'font-mono break-all' : 'break-words'}>{value}</span>
    </div>
  )
}
