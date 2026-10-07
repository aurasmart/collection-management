import { describe, expect, it } from 'vitest'
import { formatDate } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { buildPayUrl, routes } from '@/lib/routes'

describe('formatINR', () => {
  it('uses ₹ with Indian digit grouping and two decimals', () => {
    expect(formatINR(125000)).toBe('₹1,25,000.00')
    expect(formatINR('10000')).toBe('₹10,000.00')
    expect(formatINR(0)).toBe('₹0.00')
    expect(formatINR('1482350.5')).toBe('₹14,82,350.50')
  })
  it('rejects non-numeric input instead of printing garbage', () => {
    expect(() => formatINR('abc')).toThrow(RangeError)
  })
})

describe('formatDate', () => {
  it('formats date-only values without timezone drift', () => {
    expect(formatDate('2026-10-15')).toBe('15 Oct 2026')
    expect(formatDate('2026-01-01')).toBe('01 Jan 2026')
  })
  it('rejects invalid dates', () => {
    expect(() => formatDate('nope')).toThrow(RangeError)
  })
})

describe('routes', () => {
  it('builds a hash-routed customer payment URL (ADR 0002)', () => {
    expect(buildPayUrl('https://app.example.com/', 'abc_DEF-123')).toBe(
      'https://app.example.com/#/pay/abc_DEF-123',
    )
  })
  it('encodes the token and keeps one source of truth for paths', () => {
    expect(routes.pay('a/b')).toBe('/pay/a/b')
    expect(buildPayUrl('https://x.test', 'a/b')).toBe('https://x.test/#/pay/a%2Fb')
  })
})

describe('payment message and deep links', () => {
  it('drops .00 only for whole rupees', async () => {
    const { formatINRCompact } = await import('@/lib/money')
    expect(formatINRCompact('15000.00')).toBe('₹15,000')
    expect(formatINRCompact(125000)).toBe('₹1,25,000')
    expect(formatINRCompact('2500.50')).toBe('₹2,500.50')
  })

  it('builds the plain WhatsApp/SMS message from the first name, amount and link', async () => {
    const { paymentMessage, smsUrl, whatsappUrl } = await import('@/lib/contact')
    const msg = paymentMessage('Rahul Sharma', '15000.00', 'https://app.example.com/#/pay/abc')
    expect(msg).toBe(
      'Hello Rahul,\n\nYour outstanding amount is ₹15,000.\n\nPlease make the payment using the payment details below:\n\nhttps://app.example.com/#/pay/abc\n\nThank you.',
    )
    expect(whatsappUrl('+919876543210', msg)).toBe(
      `https://wa.me/919876543210?text=${encodeURIComponent(msg)}`,
    )
    expect(smsUrl('+919876543210', msg)).toBe(`sms:+919876543210?&body=${encodeURIComponent(msg)}`)
    expect(paymentMessage('  ', '1', 'x')).toMatch(/^Hello there,/)
  })
})
