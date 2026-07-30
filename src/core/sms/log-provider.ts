import { centavos, type Centavos } from '@/lib/money'

import type {
  SendSmsInput,
  SmsDeliveryEvent,
  SmsProvider,
  SmsResult,
} from './types'

/**
 * The `log` SMS provider.
 *
 * Writes to the console and reports success. It exists so the order-confirmation
 * path is a real, exercised code path from phase 6 onward instead of a stub that
 * gets wired up for the first time — and discovered to be wrong — in phase 11,
 * when Semaphore lands.
 *
 * It reports a realistic cost and segment count rather than zeroes, because the
 * credit ledger and the pre-broadcast cost preview are built on those numbers and
 * a provider that always says "free, one segment" would let a bug in that
 * arithmetic go unnoticed until it was billing a seller.
 */

/** Semaphore's list price at the time of writing: ₱0.50 per segment retail. */
const COST_PER_SEGMENT = centavos(30)

/**
 * GSM-7 characters. Anything outside this forces the whole message to UCS-2,
 * which halves the per-segment budget.
 *
 * This matters more for Taglish than it looks: `ñ` is in the GSM-7 extension, but a
 * single emoji in a promo blast doubles the segment count for every recipient.
 */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM7_EXTENDED = '^{}\\[~]|€'

export function encodingOf(body: string): 'gsm7' | 'ucs2' {
  for (const character of body) {
    if (!GSM7.includes(character) && !GSM7_EXTENDED.includes(character)) return 'ucs2'
  }
  return 'gsm7'
}

export function segmentsFor(body: string): number {
  const encoding = encodingOf(body)
  // Extended-table characters cost two septets each.
  const length =
    encoding === 'gsm7'
      ? [...body].reduce((total, c) => total + (GSM7_EXTENDED.includes(c) ? 2 : 1), 0)
      : [...body].length

  const single = encoding === 'gsm7' ? 160 : 70
  // Concatenated messages spend 6 septets (or 3 UCS-2 chars) per part on the UDH.
  const multi = encoding === 'gsm7' ? 153 : 67
  if (length === 0) return 1
  return length <= single ? 1 : Math.ceil(length / multi)
}

export function estimateSms(body: string): {
  segments: number
  cost: Centavos
  encoding: 'gsm7' | 'ucs2'
} {
  const segments = segmentsFor(body)
  return {
    segments,
    cost: centavos(COST_PER_SEGMENT * segments),
    encoding: encodingOf(body),
  }
}

export function createLogSmsProvider(
  sink: (line: string) => void = (line) => console.log(line),
): SmsProvider {
  return {
    id: 'log',
    label: 'Console log (development)',

    send(input: SendSmsInput): Promise<SmsResult> {
      const { segments, cost } = estimateSms(input.body)
      sink(`[sms:${input.purpose}] -> ${input.to} (${segments} segment(s))\n${input.body}`)
      return Promise.resolve({
        provider: 'log',
        // Derived from the idempotency key, not random: a retry of the same send
        // produces the same reference, which is what makes the log deduplicable.
        providerRef: `log-${input.idempotencyKey}`,
        to: input.to,
        status: 'sent',
        cost,
        segments,
      })
    },

    sendBatch(inputs: readonly SendSmsInput[]): Promise<SmsResult[]> {
      return Promise.all(inputs.map((input) => this.send(input)))
    },

    estimate: estimateSms,

    parseDeliveryWebhook(): SmsDeliveryEvent[] {
      // Nothing delivers a webhook to a console logger.
      return []
    },
  }
}
