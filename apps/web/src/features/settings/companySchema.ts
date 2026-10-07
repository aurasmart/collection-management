import { z } from 'zod'

/** Mirrors apps/api/app/modules/company/schemas.py (the server is authoritative). */
const PIN_RE = /^[1-9][0-9]{5}$/
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_MIN_SIDE = 64

export const COMPANY_LABELS: Record<string, string> = {
  display_name: 'Display name',
  legal_name: 'Legal name',
  address: 'Address',
  city: 'City',
  state: 'State',
  pin: 'PIN',
  gstin: 'GSTIN',
  pan: 'PAN',
  contact_person: 'Contact person',
  phone: 'Contact phone',
  email: 'Contact email',
  website: 'Website',
  logo: 'Logo',
}

/** What customers can see on the payment page. Changing these needs a recent password check. */
export const VISIBLE_FIELDS = [
  'display_name',
  'address',
  'city',
  'state',
  'pin',
  'gstin',
  'phone',
  'email',
] as const

export interface CompanyFormValues {
  display_name: string
  legal_name: string
  address: string
  city: string
  state: string
  pin: string
  gstin: string
  pan: string
  contact_person: string
  phone: string
  email: string
  website: string
}

function validWebsite(v: string): boolean {
  try {
    const u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v) ? v : `https://${v}`)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.includes('.')
  } catch {
    return false
  }
}

export const companySchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(2, 'Enter at least 2 characters')
      .max(60, 'Use at most 60 characters'),
    legal_name: z.string().trim().max(120, 'Use at most 120 characters'),
    address: z.string().trim().max(200, 'Use at most 200 characters'),
    city: z.string().trim().max(60, 'Use at most 60 characters'),
    state: z.string().trim().max(60, 'Use at most 60 characters'),
    pin: z.string().trim(),
    gstin: z.string().trim(),
    pan: z.string().trim(),
    contact_person: z.string().trim().max(80, 'Use at most 80 characters'),
    phone: z.string().trim(),
    email: z.string().trim(),
    website: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    const add = (path: keyof CompanyFormValues, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })
    if (v.pin && !PIN_RE.test(v.pin)) add('pin', 'Enter a 6-digit PIN code')
    if (v.gstin && !GSTIN_RE.test(v.gstin.toUpperCase())) {
      add('gstin', 'Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5')
    }
    if (v.pan && !PAN_RE.test(v.pan.toUpperCase())) {
      add('pan', 'Enter a valid 10-character PAN, like ABCDE1234F')
    }
    if (v.phone) {
      const digits = v.phone.replace(/[\s\-().+]/g, '')
      if (!/^\d{8,15}$/.test(digits)) add('phone', 'Enter a valid phone number')
    }
    if (v.email && (v.email.length > 120 || !EMAIL_RE.test(v.email))) {
      add('email', 'Enter a valid email address')
    }
    if (v.website && (v.website.length > 200 || !validWebsite(v.website))) {
      add('website', 'Enter a valid website address, like https://example.com')
    }
  })

type Nullable = string | null | undefined

export function toCompanyForm(d: Record<keyof CompanyFormValues, Nullable>): CompanyFormValues {
  const out = {} as CompanyFormValues
  for (const k of Object.keys(COMPANY_LABELS)) {
    if (k === 'logo') continue
    out[k as keyof CompanyFormValues] = d[k as keyof CompanyFormValues] ?? ''
  }
  return out
}

const orNull = (s: string): string | null => (s.trim() === '' ? null : s.trim())

export function toCompanyPayload(v: CompanyFormValues) {
  return {
    display_name: v.display_name.trim(),
    legal_name: orNull(v.legal_name),
    address: orNull(v.address),
    city: orNull(v.city),
    state: orNull(v.state),
    pin: orNull(v.pin),
    gstin: orNull(v.gstin)?.toUpperCase() ?? null,
    pan: orNull(v.pan)?.toUpperCase() ?? null,
    contact_person: orNull(v.contact_person),
    phone: orNull(v.phone),
    email: orNull(v.email),
    website: orNull(v.website),
  }
}

export type CompanyPayload = ReturnType<typeof toCompanyPayload>

export function changedCompanyFields(saved: CompanyFormValues, now: CompanyFormValues): string[] {
  const a = toCompanyPayload(saved)
  const b = toCompanyPayload(now)
  return (Object.keys(a) as Array<keyof CompanyPayload>).filter((k) => a[k] !== b[k])
}

export function isVisibleChange(fields: string[], logoChanged: boolean): boolean {
  return logoChanged || fields.some((f) => (VISIBLE_FIELDS as readonly string[]).includes(f))
}
