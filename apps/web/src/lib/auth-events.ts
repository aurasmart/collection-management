/** Tiny decoupling channel so the API client can tell the auth layer "the server rejected our session". */
type Listener = () => void
const listeners = new Set<Listener>()

export const authEvents = {
  onUnauthorized(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emitUnauthorized(): void {
    listeners.forEach((fn) => fn())
  },
}
