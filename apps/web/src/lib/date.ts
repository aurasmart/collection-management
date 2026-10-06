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
