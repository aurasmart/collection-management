/** Natural pixel size of an image file (client-side pre-check only; the server re-validates). */
export function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('unreadable image'))
    }
    img.src = url
  })
}

const staged = new WeakMap<File, string>()

/** One object URL per staged file (stable across renders). Call `releaseStaged` when it is discarded. */
export function stagedPreview(file: File): string {
  let url = staged.get(file)
  if (!url) {
    url = URL.createObjectURL(file)
    staged.set(file, url)
  }
  return url
}

export function releaseStaged(file: File): void {
  const url = staged.get(file)
  if (url) {
    URL.revokeObjectURL(url)
    staged.delete(file)
  }
}
