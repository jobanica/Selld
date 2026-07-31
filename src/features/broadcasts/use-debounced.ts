import { useEffect, useState } from 'react'

/**
 * Hold a value still until the seller stops changing it.
 *
 * The cost preview is a real query — `broadcast_preview` runs the segment match
 * over every customer in the store to work out who is reachable — and its query
 * key contains the message body. Without this, composing a 60-character blast
 * fires sixty of them, each one scanning the whole customer table, from a phone
 * on mobile data. Measured at 390px: five keystrokes, five round trips.
 *
 * 400ms is chosen against typing rather than against latency: it is longer than
 * the gap between two characters of ordinary typing and shorter than the pause
 * someone takes to re-read what they wrote, so the number lands when the seller
 * looks up at it.
 *
 * The debounce is on the *display* only. Nothing here decides what is charged —
 * `broadcast_claim_next` takes the credit in SQL, per recipient, at send time —
 * so a quote that is 400ms stale can never turn into a wrong bill.
 */
export function useDebounced<T>(value: T, delayMs = 400): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return settled
}
