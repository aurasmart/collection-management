const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Always ₹ with Indian digit grouping, e.g. ₹1,25,000.00 (Stage 2 §2 principle 1). */
export function formatINR(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) throw new RangeError(`Not a money amount: ${String(value)}`)
  return inr.format(n)
}

/** Like formatINR but drops ".00" for whole rupees: ₹15,000 (used in messages and confirmations). */
export function formatINRCompact(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) throw new RangeError(`Not a money amount: ${String(value)}`)
  return Number.isInteger(n) ? inr.format(n).replace(/\.00$/, '') : inr.format(n)
}
