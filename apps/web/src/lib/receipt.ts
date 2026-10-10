/** Receipt files (payment proof and petty cash): an image or a PDF, at most 5 MB. */
export const RECEIPT_ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf'
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])

/** A friendly reason the file can't be used, or null. The server checks again. */
export function receiptProblem(file: File): string | null {
  if (!ALLOWED.has(file.type)) return 'Choose a PNG, JPG or WebP image, or a PDF'
  if (file.size > RECEIPT_MAX_BYTES) return 'This file is larger than 5 MB'
  if (file.size === 0) return 'This file is empty'
  return null
}

/**
 * Receipts are private, so they are fetched with the session token and shown from a blob URL. The
 * tab is opened first (inside the click) so pop-up blockers allow it.
 */
export async function openReceipt(load: () => Promise<Blob | undefined>): Promise<boolean> {
  const tab = window.open('', '_blank')
  try {
    const blob = await load()
    if (!blob) throw new Error('No receipt')
    const url = URL.createObjectURL(blob)
    if (tab) tab.location.href = url
    else window.location.href = url
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  } catch {
    tab?.close()
    return false
  }
}

/** Multipart body for openapi-fetch (the typed body is a placeholder; the serializer sends the file). */
export function fileForm(file: File, extra: Record<string, string> = {}): () => FormData {
  return () => {
    const fd = new FormData()
    fd.append('file', file)
    for (const [k, v] of Object.entries(extra)) fd.append(k, v)
    return fd
  }
}
