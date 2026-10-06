import { z } from 'zod'

/** Mirrors the server rules in apps/api/app/modules/settings/schemas.py (the server is authoritative). */
const UPI_ID_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,63}$/
const UPI_NUMBER_RE = /^[6-9][0-9]{9}$/
const ACCOUNT_NUMBER_RE = /^[0-9]{9,18}$/
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

export const QR_MAX_BYTES = 2 * 1024 * 1024
export const QR_MIN_SIDE = 300

export const FIELD_LABELS: Record<string, string> = {
  display_name: 'Display name',
  upi_id: 'UPI ID',
  upi_number: 'UPI number',
  bank_name: 'Bank name',
  account_name: 'Account holder name',
  account_number: 'Account number',
  ifsc: 'IFSC',
  upi_enabled: 'Show UPI ID',
  upi_number_enabled: 'Show UPI number',
  qr_enabled: 'Show QR code',
  bank_enabled: 'Show bank details',
  qr_code: 'QR code',
}

export const SENSITIVE_FIELDS = [
  'upi_id',
  'upi_number',
  'bank_name',
  'account_name',
  'account_number',
  'ifsc',
  'upi_enabled',
  'upi_number_enabled',
  'qr_enabled',
  'bank_enabled',
] as const

export interface FormValues {
  display_name: string
  upi_id: string
  upi_number: string
  bank_name: string
  account_name: string
  account_number: string
  account_number_confirm: string
  ifsc: string
  upi_enabled: boolean
  upi_number_enabled: boolean
  qr_enabled: boolean
  bank_enabled: boolean
}

/** `hasQr` = whether a QR image will exist after this save (stored and not being removed, or being uploaded). */
export function makeSettingsSchema(hasQr: boolean) {
  return z
    .object({
      display_name: z
        .string()
        .trim()
        .min(2, 'Enter at least 2 characters')
        .max(60, 'Use at most 60 characters'),
      upi_id: z.string().trim(),
      upi_number: z.string().trim(),
      bank_name: z.string().trim(),
      account_name: z.string().trim(),
      account_number: z.string().trim(),
      account_number_confirm: z.string().trim(),
      ifsc: z.string().trim(),
      upi_enabled: z.boolean(),
      upi_number_enabled: z.boolean(),
      qr_enabled: z.boolean(),
      bank_enabled: z.boolean(),
    })
    .superRefine((v, ctx) => {
      const add = (path: keyof FormValues, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message })

      if (v.upi_id && !UPI_ID_RE.test(v.upi_id))
        add('upi_id', 'Enter a valid UPI ID, like name@bank')
      if (v.upi_number && !UPI_NUMBER_RE.test(v.upi_number)) {
        add('upi_number', 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9')
      }
      if (v.bank_name && v.bank_name.length < 2)
        add('bank_name', 'Bank name must be 2 to 60 characters')
      if (v.bank_name.length > 60) add('bank_name', 'Bank name must be 2 to 60 characters')
      if (v.account_name && (v.account_name.length < 2 || v.account_name.length > 80)) {
        add('account_name', 'Account holder name must be 2 to 80 characters')
      }
      if (v.account_number && !ACCOUNT_NUMBER_RE.test(v.account_number)) {
        add('account_number', 'Account number must be 9 to 18 digits')
      }
      if (v.account_number && v.account_number_confirm !== v.account_number) {
        add('account_number_confirm', 'Account numbers do not match')
      }
      if (v.ifsc && !IFSC_RE.test(v.ifsc.toUpperCase())) {
        add('ifsc', 'Enter a valid IFSC, like HDFC0001234')
      }

      if (v.upi_enabled && !v.upi_id) add('upi_id', 'Enter your UPI ID to show it to customers')
      if (v.upi_number_enabled && !v.upi_number) {
        add('upi_number', 'Enter your UPI number to show it to customers')
      }
      if (v.qr_enabled && !hasQr) add('qr_enabled', 'Upload a QR code before turning this on')
      if (v.bank_enabled) {
        if (!v.bank_name) add('bank_name', 'Enter the bank name to show bank details')
        if (!v.account_name)
          add('account_name', 'Enter the account holder name to show bank details')
        if (!v.account_number)
          add('account_number', 'Enter the account number to show bank details')
        if (!v.ifsc) add('ifsc', 'Enter the IFSC to show bank details')
      }
    })
}

type Nullable = string | null | undefined

export function toFormValues(d: {
  display_name: Nullable
  upi_id: Nullable
  upi_number: Nullable
  bank_name: Nullable
  account_name: Nullable
  account_number: Nullable
  ifsc: Nullable
  upi_enabled: boolean
  upi_number_enabled: boolean
  qr_enabled: boolean
  bank_enabled: boolean
}): FormValues {
  return {
    display_name: d.display_name ?? '',
    upi_id: d.upi_id ?? '',
    upi_number: d.upi_number ?? '',
    bank_name: d.bank_name ?? '',
    account_name: d.account_name ?? '',
    account_number: d.account_number ?? '',
    account_number_confirm: d.account_number ?? '',
    ifsc: d.ifsc ?? '',
    upi_enabled: d.upi_enabled,
    upi_number_enabled: d.upi_number_enabled,
    qr_enabled: d.qr_enabled,
    bank_enabled: d.bank_enabled,
  }
}

const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim())

export function toPayload(v: FormValues) {
  return {
    display_name: v.display_name.trim(),
    upi_id: orNull(v.upi_id),
    upi_number: orNull(v.upi_number),
    bank_name: orNull(v.bank_name),
    account_name: orNull(v.account_name),
    account_number: orNull(v.account_number),
    ifsc: orNull(v.ifsc)?.toUpperCase() ?? null,
    upi_enabled: v.upi_enabled,
    upi_number_enabled: v.upi_number_enabled,
    qr_enabled: v.qr_enabled,
    bank_enabled: v.bank_enabled,
  }
}

export type SettingsPayload = ReturnType<typeof toPayload>

/** Which saved fields differ (by name). Display name alone is not sensitive. */
export function changedFields(saved: FormValues, now: FormValues): string[] {
  const a = toPayload(saved)
  const b = toPayload(now)
  return (Object.keys(a) as Array<keyof SettingsPayload>).filter((k) => a[k] !== b[k])
}

export function isSensitiveChange(fields: string[], qrChanged: boolean): boolean {
  return qrChanged || fields.some((f) => (SENSITIVE_FIELDS as readonly string[]).includes(f))
}
