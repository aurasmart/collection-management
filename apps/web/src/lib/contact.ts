import { formatINRCompact } from '@/lib/money'

/** Plain deep links only: they open the employer's own WhatsApp / SMS app. No provider, no API. */

export function paymentMessage(
  customerName: string,
  amount: string | number,
  link: string,
): string {
  const first = customerName.trim().split(/\s+/)[0] || 'there'
  return (
    `Hello ${first},\n\n` +
    `Your outstanding amount is ${formatINRCompact(amount)}.\n\n` +
    `Please make the payment using the payment details below:\n\n${link}\n\nThank you.`
  )
}

const digits = (phone: string) => phone.replace(/\D/g, '')

export function whatsappUrl(phone: string, message: string): string {
  return `https://wa.me/${digits(phone)}?text=${encodeURIComponent(message)}`
}

export function smsUrl(phone: string, message: string): string {
  // "?&body=" is understood by both Android and iOS messaging apps.
  return `sms:+${digits(phone)}?&body=${encodeURIComponent(message)}`
}

/** +919876543210 -> +91 98765 43210 (display only; the stored value stays E.164). */
export function formatPhone(phone: string | null): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone ?? '')
  return m ? `+91 ${m[1]} ${m[2]}` : (phone ?? '')
}
