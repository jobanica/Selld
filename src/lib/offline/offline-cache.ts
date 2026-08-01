/**
 * The last thing we knew, kept where a packer can still read it.
 *
 * The service worker deliberately caches no API responses — every one of them is
 * tenant-scoped and personal, and a shared phone with a stale HTTP cache is one
 * seller reading another's orders. So offline *data* is held here instead, in the
 * app, where three things are true that are not true of an HTTP cache:
 *
 *   it is keyed by tenant, so switching stores cannot show the wrong list;
 *   it is cleared on sign-out, because a packer who hands the phone back should
 *   not be handing over the customer list with it;
 *   and it is explicit — a screen opts in to being available offline, rather
 *   than everything being retained by accident.
 *
 * `localStorage` rather than IndexedDB. The payload is a page of orders, a few
 * tens of kilobytes; IndexedDB would buy asynchrony this does not need and cost a
 * schema, a version and an upgrade path.
 */

const PREFIX = 'selld.offline.'

export interface Snapshot<T> {
  /** When the data was last known to be true. Shown, not just stored. */
  at: string
  data: T
}

function key(name: string, tenantId: string): string {
  return `${PREFIX}${name}.${tenantId}`
}

export function saveSnapshot<T>(name: string, tenantId: string, data: T): void {
  try {
    localStorage.setItem(
      key(name, tenantId),
      JSON.stringify({ at: new Date().toISOString(), data } satisfies Snapshot<T>),
    )
  } catch {
    // A full or disabled store must never break the screen that was merely
    // trying to be helpful.
  }
}

export function readSnapshot<T>(name: string, tenantId: string): Snapshot<T> | null {
  try {
    const raw = localStorage.getItem(key(name, tenantId))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Snapshot<T>
    return typeof parsed.at === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Everything this device remembered, gone.
 *
 * Called on sign-out. Iterating the whole of `localStorage` rather than
 * remembering what was written: the alternative is a registry that has to be kept
 * in step with every screen that ever cached anything, and the one screen that
 * forgets to register is the one that leaves a customer list behind.
 */
export function clearSnapshots(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const name = localStorage.key(i)
      if (name !== null && name.startsWith(PREFIX)) doomed.push(name)
    }
    for (const name of doomed) localStorage.removeItem(name)
  } catch {
    /* nothing to clear */
  }
}

/** A queued write, waiting for a network. */
export interface PendingMove {
  id: string
  orderIds: string[]
  toStatus: string
  queuedAt: string
}

const QUEUE = 'queue'

export function readQueue(tenantId: string): PendingMove[] {
  return readSnapshot<PendingMove[]>(QUEUE, tenantId)?.data ?? []
}

/**
 * Queue a move rather than failing it.
 *
 * A packer holding a parcel has already done the work; refusing to record it
 * because the signal dropped means they either do it twice or not at all. The
 * queue is flushed by `flushQueue` the moment the app is online again, and the
 * move it replays is idempotent on the server — `orders_bulk_transition` skips an
 * order that is already in the target state.
 */
export function enqueueMove(tenantId: string, move: Omit<PendingMove, 'id' | 'queuedAt'>): void {
  const queue = readQueue(tenantId)
  queue.push({
    ...move,
    id: `${String(Date.now())}-${String(queue.length)}`,
    queuedAt: new Date().toISOString(),
  })
  saveSnapshot(QUEUE, tenantId, queue)
}

export function clearQueue(tenantId: string): void {
  saveSnapshot(QUEUE, tenantId, [] as PendingMove[])
}
