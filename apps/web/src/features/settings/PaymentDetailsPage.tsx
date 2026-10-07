import { useEffect, useRef, useState, type ReactNode } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { useForm, useWatch, type Resolver } from 'react-hook-form'
import { Link } from 'react-router'
import { Alert, Button, Modal, Skeleton, TextField, useToast } from '@/components/ui'
import { PasswordConfirmModal } from '@/features/auth/PasswordConfirmModal'
import { useAuth } from '@/features/auth/AuthProvider'
import {
  SETTINGS_KEY,
  savePaymentSettings,
  usePaymentQrUrl,
  usePaymentSettings,
  type PaymentSettings,
  type QrAction,
} from '@/features/settings/api'
import { useCompanyLogoUrl, useCompanyProfile } from '@/features/settings/companyApi'
import { PaymentPreview } from '@/features/settings/PaymentPreview'
import { RecentChanges, Section, UnsavedChangesDialog } from '@/features/settings/shared'
import { useUnsavedGuard } from '@/features/settings/useUnsavedGuard'
import { QrField } from '@/features/settings/QrField'
import {
  FIELD_LABELS,
  changedFields,
  isSensitiveChange,
  makeSettingsSchema,
  toFormValues,
  toPayload,
  type FormValues,
} from '@/features/settings/schema'
import { routes } from '@/lib/routes'
import { stagedPreview } from '@/lib/image'

export function PaymentDetailsPage() {
  const query = usePaymentSettings()
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-semibold">Payment details</h2>
      {query.isPending && <SettingsSkeleton />}
      {query.isError && (
        <Alert
          tone="error"
          title="Couldn't load payment settings"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Check your connection and try again.
        </Alert>
      )}
      {query.data && <SettingsForm key={query.data.updated_at ?? 'new'} data={query.data} />}
    </div>
  )
}

function SettingsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading payment settings…</span>
      <Skeleton className="h-6 w-2/3" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  )
}

const ENABLED_KEYS = ['upi_enabled', 'upi_number_enabled', 'qr_enabled', 'bank_enabled'] as const

function SettingsForm({ data }: { data: PaymentSettings }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { email, confirmPassword } = useAuth()
  const saved = toFormValues(data)

  const [qrAction, setQrAction] = useState<QrAction>({ kind: 'none' })
  const [qrError, setQrError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<FormValues | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  const hasQrAfterSave = (data.has_qr && qrAction.kind !== 'remove') || qrAction.kind === 'upload'
  const hasQrRef = useRef(hasQrAfterSave)
  useEffect(() => {
    hasQrRef.current = hasQrAfterSave
  }, [hasQrAfterSave])

  const resolver: Resolver<FormValues> = (values, ctx, options) =>
    (zodResolver(makeSettingsSchema(hasQrRef.current)) as unknown as Resolver<FormValues>)(
      values,
      ctx,
      options,
    )

  const form = useForm<FormValues>({ defaultValues: saved, resolver })
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    trigger,
    formState: { errors, isDirty, submitCount },
  } = form
  const values = useWatch({ control }) as FormValues

  const companyQuery = useCompanyProfile()
  const companyLogo = useCompanyLogoUrl(
    companyQuery.data?.has_logo ?? false,
    companyQuery.data?.updated_at ?? null,
  )
  const company = {
    name: companyQuery.data?.display_name ?? '',
    logoUrl: companyLogo.data ?? null,
  }
  const qrQuery = usePaymentQrUrl(data.has_qr, data.updated_at)
  const serverQrUrl = qrQuery.data ?? null
  const previewQr =
    qrAction.kind === 'remove'
      ? null
      : qrAction.kind === 'upload'
        ? stagedPreview(qrAction.file)
        : serverQrUrl

  const dirty = isDirty || qrAction.kind !== 'none'

  // Re-validate QR-dependent rules when the staged QR changes.
  useEffect(() => {
    if (submitCount > 0) void trigger('qr_enabled')
  }, [qrAction, submitCount, trigger])

  const blocker = useUnsavedGuard(dirty)

  async function doSave(v: FormValues) {
    setSaving(true)
    setFormError(null)
    setQrError(null)
    const result = await savePaymentSettings(toPayload(v), qrAction)
    setSaving(false)
    if (result.ok) {
      qc.setQueryData(SETTINGS_KEY, result.data)
      setQrAction({ kind: 'none' })
      reset(toFormValues(result.data))
      toast({ title: 'Payment details saved', tone: 'success' })
      return
    }
    if (result.qrApplied) await qc.invalidateQueries({ queryKey: SETTINGS_KEY })
    if (result.kind === 'reauth') {
      setPending(v) // the confirmation window lapsed: ask again, nothing was changed
      return
    }
    if (result.kind === 'validation') {
      let general = false
      for (const e of result.errors) {
        if (e.field === 'qr') setQrError(e.message)
        else if (e.field in saved) setError(e.field as keyof FormValues, { message: e.message })
        else general = true
      }
      if (general || result.errors.length === 0)
        setFormError('Please check the highlighted fields.')
      return
    }
    setFormError(
      result.qrApplied
        ? 'The QR image was saved but your other changes were not. Please try again.'
        : "Couldn't save. Your previous details are unchanged.",
    )
  }

  const onValid = (v: FormValues) => {
    const sensitive = isSensitiveChange(changedFields(saved, v), qrAction.kind !== 'none')
    if (sensitive)
      setPending(v) // password confirmation first (Stage 2 S10 / Stage 3 re-auth)
    else void doSave(v)
  }

  const configured = data.updated_at !== null
  const noneEnabled = !ENABLED_KEYS.some((k) => data[k])

  return (
    <>
      <Alert tone="info">
        These are the payment methods customers see on their payment page. Your company name and
        logo come from your{' '}
        <Link className="underline" to={routes.settingsCompany}>
          Company profile
        </Link>
        .
      </Alert>
      {!configured && (
        <Alert tone="info" title="Add your payment details so customers know how to pay." />
      )}
      {configured && noneEnabled && (
        <Alert tone="warning" title="No payment method enabled">
          You can't create payment requests yet. Turn on at least one method below.
        </Alert>
      )}
      {formError && <Alert tone="error">{formError}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <form
          onSubmit={handleSubmit(onValid, () =>
            setFormError('Please check the highlighted fields.'),
          )}
          className="flex flex-col gap-4"
          noValidate
          aria-label="Payment details"
        >
          <Section
            title="UPI ID"
            toggle={toggle('upi_enabled', register, 'Show UPI ID to customers')}
          >
            <TextField
              label="UPI ID"
              placeholder="name@bank"
              autoCapitalize="none"
              error={errors.upi_id?.message}
              {...register('upi_id')}
            />
          </Section>

          <Section
            title="UPI number"
            toggle={toggle('upi_number_enabled', register, 'Show UPI number to customers')}
          >
            <TextField
              label="UPI number"
              placeholder="10-digit mobile number"
              inputMode="numeric"
              error={errors.upi_number?.message}
              {...register('upi_number')}
            />
          </Section>

          <Section
            title="QR code"
            toggle={toggle('qr_enabled', register, 'Show QR code to customers')}
          >
            <QrField
              serverQrUrl={serverQrUrl}
              action={qrAction}
              onAction={(a) => {
                setQrAction(a)
                setQrError(null)
              }}
              serverError={qrError}
            />
            {errors.qr_enabled?.message && (
              <p role="alert" className="text-sm text-danger">
                {errors.qr_enabled.message}
              </p>
            )}
          </Section>

          <Section
            title="Bank transfer"
            toggle={toggle('bank_enabled', register, 'Show bank details to customers')}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Bank name"
                placeholder="e.g. HDFC Bank"
                error={errors.bank_name?.message}
                {...register('bank_name')}
              />
              <TextField
                label="Account holder name"
                placeholder="As per bank records"
                error={errors.account_name?.message}
                {...register('account_name')}
              />
              <TextField
                label="Account number"
                placeholder="Digits only"
                inputMode="numeric"
                autoComplete="off"
                error={errors.account_number?.message}
                {...register('account_number')}
              />
              <TextField
                label="Re-enter account number"
                placeholder="Digits only"
                inputMode="numeric"
                autoComplete="off"
                error={errors.account_number_confirm?.message}
                {...register('account_number_confirm')}
              />
              <TextField
                label="IFSC"
                placeholder="e.g. HDFC0001234"
                autoCapitalize="characters"
                error={errors.ifsc?.message}
                {...register('ifsc')}
              />
            </div>
          </Section>

          <div className="sticky bottom-14 z-20 -mx-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3 sm:bottom-0 sm:mx-0 sm:rounded-card sm:border">
            <Button type="submit" loading={saving} disabled={!dirty}>
              {saving ? 'Saving…' : 'Save payment details'}
            </Button>
            <Button
              variant="secondary"
              disabled={!dirty || saving}
              onClick={() => {
                reset(saved)
                setQrAction({ kind: 'none' })
                setFormError(null)
                setQrError(null)
              }}
            >
              Discard changes
            </Button>
            <Button
              variant="tertiary"
              className="ml-auto lg:hidden"
              onClick={() => setPreviewOpen(true)}
            >
              <Eye className="size-5" aria-hidden="true" />
              Preview
            </Button>
          </div>
        </form>

        <aside className="hidden lg:block">
          <div className="sticky top-20">
            <PaymentPreview values={values} qrUrl={previewQr} company={company} />
          </div>
        </aside>
      </div>

      <RecentChanges changes={data.recent_changes} myEmail={email} labels={FIELD_LABELS} />

      <Modal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title="Preview"
        description="How your payment details will look to customers."
      >
        <PaymentPreview values={values} qrUrl={previewQr} company={company} />
      </Modal>

      <PasswordConfirmModal
        open={pending !== null}
        dismissible
        title="Confirm it's you"
        description="Enter your password to change payment details. This protects your customers from details being changed by someone else."
        submitLabel="Confirm and save"
        onCancel={() => setPending(null)}
        onSubmit={async (password) => {
          const result = await confirmPassword(password)
          if (result.ok && pending) {
            const v = pending
            setPending(null)
            await doSave(v)
          }
          return result
        }}
      />

      <UnsavedChangesDialog blocker={blocker} what="payment details" />
    </>
  )
}

type Register = ReturnType<typeof useForm<FormValues>>['register']

function toggle(name: (typeof ENABLED_KEYS)[number], register: Register, label: string): ReactNode {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        role="switch"
        className="size-5 accent-accent"
        aria-label={label}
        {...register(name)}
      />
      <span>{label}</span>
    </label>
  )
}
