const display = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** `YYYY-MM-DD` (or ISO timestamp) -> `15 Oct 2026`. Date-only values are not timezone shifted. */
export function formatDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) throw new RangeError(`Not a date: ${iso}`)
  return display.format(d)
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
})

/** ISO timestamp -> `14 Oct 2026, 4:12 pm` (India time, per the frozen market default). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new RangeError(`Not a date: ${iso}`)
  return dateTime.format(d)
}
