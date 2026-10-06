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
