import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { Alert, Button, Skeleton, TextField, useToast } from '@/components/ui'
import { PasswordConfirmModal } from '@/features/auth/PasswordConfirmModal'
import { useAuth } from '@/features/auth/AuthProvider'
import {
  COMPANY_KEY,
  saveCompanyProfile,
  useCompanyLogoUrl,
  useCompanyProfile,
  type CompanyProfile,
  type LogoAction,
} from '@/features/settings/companyApi'
import {
  COMPANY_LABELS,
  changedCompanyFields,
  companySchema,
  isVisibleChange,
  toCompanyForm,
  toCompanyPayload,
  type CompanyFormValues,
} from '@/features/settings/companySchema'
import { LogoField } from '@/features/settings/LogoField'
import { RecentChanges, Section, UnsavedChangesDialog } from '@/features/settings/shared'
import { useUnsavedGuard } from '@/features/settings/useUnsavedGuard'

export function CompanyProfilePage() {
  const query = useCompanyProfile()
  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-semibold">Company profile</h2>
      {query.isPending && (
        <div role="status" aria-busy="true" className="flex flex-col gap-4">
          <span className="sr-only">Loading company profile…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      )}
      {query.isError && (
        <Alert
          tone="error"
          title="Couldn't load the company profile"
          action={
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Check your connection and try again.
        </Alert>
      )}
      {query.data && <ProfileForm key={query.data.updated_at ?? 'new'} data={query.data} />}
    </div>
  )
}

function ProfileForm({ data }: { data: CompanyProfile }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { email, confirmPassword } = useAuth()
  const saved = toCompanyForm(data)

  const [logo, setLogo] = useState<LogoAction>({ kind: 'none' })
  const [logoError, setLogoError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<CompanyFormValues | null>(null)

  const form = useForm<CompanyFormValues>({
    defaultValues: saved,
    resolver: zodResolver(companySchema) as never,
  })
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = form
  const dirty = isDirty || logo.kind !== 'none'
  const blocker = useUnsavedGuard(dirty)
  const logoQuery = useCompanyLogoUrl(data.has_logo, data.updated_at)

  async function doSave(v: CompanyFormValues) {
    setSaving(true)
    setFormError(null)
    setLogoError(null)
    const result = await saveCompanyProfile(toCompanyPayload(v), logo)
    setSaving(false)
    if (result.ok) {
      qc.setQueryData(COMPANY_KEY, result.data)
      void qc.invalidateQueries({ queryKey: ['public-pay'] })
      setLogo({ kind: 'none' })
      reset(toCompanyForm(result.data))
      toast({ title: 'Company profile saved', tone: 'success' })
      return
    }
    if (result.qrApplied) await qc.invalidateQueries({ queryKey: COMPANY_KEY })
    if (result.kind === 'reauth') {
      setPending(v)
      return
    }
    if (result.kind === 'validation') {
      let general = false
      for (const e of result.errors) {
        if (e.field === 'logo') setLogoError(e.message)
        else if (e.field in saved)
          setError(e.field as keyof CompanyFormValues, { message: e.message })
        else general = true
      }
      if (general || result.errors.length === 0)
        setFormError('Please check the highlighted fields.')
      return
    }
    setFormError(
      result.qrApplied
        ? 'The logo was saved but your other changes were not. Please try again.'
        : "Couldn't save. Your previous details are unchanged.",
    )
  }

  const onValid = (v: CompanyFormValues) => {
    const visible =
      !data.saved || isVisibleChange(changedCompanyFields(saved, v), logo.kind !== 'none')
    if (visible) setPending(v)
    else void doSave(v)
  }

  const f = (name: keyof CompanyFormValues) => ({ error: errors[name]?.message, ...register(name) })

  return (
    <>
      <Alert tone="info">
        Your company name, logo, phone, email, address and GSTIN appear on the payment page your
        customers open. Legal name, PAN, contact person and website are never shown to customers.
      </Alert>
      {formError && <Alert tone="error">{formError}</Alert>}

      <form
        onSubmit={handleSubmit(onValid, () => setFormError('Please check the highlighted fields.'))}
        className="flex flex-col gap-4"
        noValidate
        aria-label="Company profile"
      >
        <Section title="Business identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Company / business display name"
              placeholder="Name customers will recognise"
              helper="Shown at the top of every payment page."
              required
              {...f('display_name')}
            />
            <TextField
              label="Legal / business name"
              placeholder="As registered"
              autoComplete="organization"
              {...f('legal_name')}
            />
          </div>
        </Section>

        <Section title="Logo">
          <LogoField
            serverLogoUrl={logoQuery.data ?? null}
            action={logo}
            onAction={(a) => {
              setLogo(a)
              setLogoError(null)
            }}
            serverError={logoError}
          />
        </Section>

        <Section title="Address">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Address"
              className="sm:col-span-2"
              autoComplete="street-address"
              {...f('address')}
            />
            <TextField label="City" autoComplete="address-level2" {...f('city')} />
            <TextField label="State" autoComplete="address-level1" {...f('state')} />
            <TextField
              label="PIN code"
              inputMode="numeric"
              autoComplete="postal-code"
              placeholder="6 digits"
              {...f('pin')}
            />
          </div>
        </Section>

        <Section title="Tax details">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="GSTIN"
              placeholder="e.g. 27ABCDE1234F1Z5"
              autoCapitalize="characters"
              helper="Shown to customers if you add it."
              {...f('gstin')}
            />
            <TextField
              label="PAN"
              placeholder="e.g. ABCDE1234F"
              autoCapitalize="characters"
              helper="Kept private. Never shown to customers."
              {...f('pan')}
            />
          </div>
        </Section>

        <Section title="Contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Contact person" autoComplete="name" {...f('contact_person')} />
            <TextField
              label="Contact phone"
              inputMode="tel"
              autoComplete="tel"
              placeholder="e.g. 98765 43210"
              {...f('phone')}
            />
            <TextField
              label="Contact email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              {...f('email')}
            />
            <TextField
              label="Website"
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://example.com"
              helper="Kept private. Not shown to customers."
              {...f('website')}
            />
          </div>
        </Section>

        <div className="sticky bottom-14 z-20 -mx-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3 sm:bottom-0 sm:mx-0 sm:rounded-card sm:border">
          <Button type="submit" loading={saving} disabled={!dirty && data.saved}>
            {saving ? 'Saving…' : 'Save company profile'}
          </Button>
          <Button
            variant="secondary"
            disabled={!dirty || saving}
            onClick={() => {
              reset(saved)
              setLogo({ kind: 'none' })
              setFormError(null)
              setLogoError(null)
            }}
          >
            Discard changes
          </Button>
        </div>
      </form>

      <RecentChanges changes={data.recent_changes} myEmail={email} labels={COMPANY_LABELS} />

      <PasswordConfirmModal
        open={pending !== null}
        dismissible
        title="Confirm it's you"
        description="Enter your password to change company details your customers can see. This protects them from details being changed by someone else."
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
      <UnsavedChangesDialog blocker={blocker} what="company profile" />
    </>
  )
}
