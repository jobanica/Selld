import { useTranslation } from 'react-i18next'

import { formatPHP } from '@/lib/money'

import {
  money,
  nextAddressLevel,
  type CartPageData,
  type CheckoutAddress,
  type PsgcOptions,
} from '../cart-data'
import { StoreFooter } from '../components/store-footer'
import { StoreHeader } from '../components/store-header'
import { Totals } from './cart-page'

/**
 * Guest checkout, on one page.
 *
 * The brief lists five steps — contact → address → shipping → payment → review. The
 * *order* is honoured exactly; the page count is not. Five screens on a 3G
 * connection is five round trips, and the done-when for this phase is a stopwatch:
 * a full checkout in under 60 seconds. One scrollable page in the specified order,
 * with the review permanently visible as the totals block, is measurably faster than
 * navigating between five.
 *
 * Typing is kept to three fields — name, phone, street — because that is the
 * genuine minimum for a deliverable PH address. Region/city/barangay are taps, and
 * a returning buyer on the same device gets all of it prefilled from their own
 * cookie.
 *
 * The whole form is one `<form method="post">`. The address cascade is one
 * server round trip per level either way: without JavaScript the buyer taps a
 * labelled button, and with it the select submits the form itself. Enhancing the
 * *trigger* rather than adding a second way to fetch options means there is only
 * one code path to be correct, and no path where checkout needs JavaScript at all.
 */
export function CheckoutPage({
  data,
}: {
  data: Extract<CartPageData, { route: 'checkout' }>
}) {
  const { t } = useTranslation()
  const { quote, contact, address, options, error } = data

  if (quote === null) return null

  const level = nextAddressLevel(address, options)

  // Note what is NOT here: `disabled={!isDeliverable(address)}` on the submit.
  //
  // `address` is the state the *server* last saw. A buyer who has just chosen a
  // barangay has not told the server yet, so a button disabled on that basis greys
  // out at the exact moment they are ready — a dead end with no explanation. And it
  // is unnecessary: `intent=place` posts the whole form, so the barangay arrives
  // with it, and the order goes through on that one tap instead of needing a
  // cascade round trip first.
  //
  // If something really is missing, `checkout_place_order` says which field and the
  // form re-renders with the message. Server validation is the authority either
  // way; the disabled attribute only ever duplicated it badly.

  return (
    <>
      <StoreHeader showSearch={false} />

      <main className="mx-auto w-full max-w-2xl px-4 pb-40 sm:pb-16">
        <h1 className="py-4 font-headline text-xl font-bold tracking-tight sm:text-2xl">
          {t('checkout.title')}
        </h1>

        {error !== null && (
          <p role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {t(`checkout.error.${error.message}` as 'checkout.error.unknown')}
          </p>
        )}

        <form method="post" action="/checkout" className="flex flex-col gap-6" data-checkout-form>
          {/* 1 — Contact */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('checkout.contactHeading')}
            </h2>
            <Field
              id="name"
              name="name"
              label={t('checkout.name')}
              defaultValue={contact.name}
              required
              autoComplete="name"
              invalid={error?.field === 'contact_name'}
            />
            <Field
              id="phone"
              name="phone"
              label={t('checkout.phone')}
              defaultValue={contact.phone}
              required
              // `tel` opens the numeric keypad and lets the browser offer the
              // number it already knows, which is the single biggest saving in
              // typed characters on this form.
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0917 123 4567"
              hint={t('checkout.phoneHint')}
              invalid={error?.field === 'contact_phone'}
            />
            <Field
              id="email"
              name="email"
              label={t('checkout.emailOptional')}
              defaultValue={contact.email}
              type="email"
              inputMode="email"
              autoComplete="email"
            />
          </section>

          {/* 2 — Address */}
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('checkout.addressHeading')}
            </h2>

            <AddressCascade address={address} options={options} />

            <Field
              id="street"
              name="street"
              label={t('checkout.street')}
              defaultValue={address.street ?? ''}
              autoComplete="address-line1"
            />
            <Field
              id="landmark"
              name="landmark"
              label={t('checkout.landmark')}
              defaultValue={address.landmark ?? ''}
              placeholder={t('checkout.landmarkPlaceholder')}
              // Not decoration. PH riders navigate by landmark far more than by
              // house number, and a good one is the difference between delivered
              // and returned-to-sender.
              hint={t('checkout.landmarkHint')}
            />

            {/*
              The cascade trigger. A <select> cannot submit on its own without
              JavaScript, so while a level is unresolved this button does it. Once
              hydrated the select calls `requestSubmit` with this same button, so
              both paths take the identical server round trip.
            */}
            {level !== null && (
              <button
                type="submit"
                name="intent"
                value="refresh"
                data-cascade-next
                className="h-11 self-start rounded-full border px-5 text-sm font-medium"
              >
                {t(`checkout.next.${level}` as 'checkout.next.city')}
              </button>
            )}
          </section>

          {/* 3 — Shipping */}
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('checkout.shippingHeading')}
            </h2>
            <div className="flex items-baseline justify-between gap-3 rounded-lg border p-3 text-sm">
              <span className="min-w-0">
                {/* The zone's own name, because "Standard delivery" tells a buyer in
                    Davao nothing about why they are paying ₱80 and not ₱200. */}
                <span className="block">
                  {quote.shipping?.rateName ?? t('checkout.standardShipping')}
                </span>
                {quote.shipping?.zoneName !== null && quote.shipping?.zoneName !== undefined && (
                  <span className="block text-xs text-muted-foreground">
                    {quote.shipping.zoneName}
                  </span>
                )}
                {quote.shippingEstimated === true && (
                  <span className="block text-xs text-muted-foreground">
                    {t('checkout.shippingPendingAddress')}
                  </span>
                )}
              </span>
              <span className="shrink-0 font-semibold">
                {quote.shippingTotal === 0
                  ? t('cart.free')
                  : formatPHP(money(quote.shippingTotal))}
              </span>
            </div>
            {quote.shipping?.freeApplied === true && (
              <p className="text-xs text-success">{t('checkout.freeShippingApplied')}</p>
            )}
          </section>

          {/* 4 — Payment */}
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('checkout.paymentHeading')}
            </h2>
            {/*
              COD only, and said plainly. Online payment is phase 8 — offering a
              GCash button now would create orders that cannot be paid, and the
              server refuses any method other than `cod` regardless of what the
              form posts.
            */}
            {/*
              A COD-blocked item makes this store's only live payment method
              unavailable, so say that rather than showing a control that will be
              refused. `checkout_place_order` refuses it regardless of what the form
              posts — this is the explanation, not the enforcement.
            */}
            {quote.codAllowed === false ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
              >
                {t('checkout.codBlockedItem')}
              </p>
            ) : (
              <label className="flex items-start gap-3 rounded-lg border border-primary bg-primary/5 p-3">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="cod"
                  defaultChecked
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                <span className="text-sm">
                  <span className="block font-medium">{t('checkout.cod')}</span>
                  <span className="block text-muted-foreground">{t('checkout.codHint')}</span>
                </span>
              </label>
            )}
            <p className="text-xs text-muted-foreground">{t('checkout.onlineSoon')}</p>
          </section>

          {/* 5 — Review */}
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('checkout.reviewHeading')}
            </h2>
            <ul className="flex flex-col divide-y rounded-lg border text-sm">
              {quote.items.map((line) => (
                <li key={line.variantId} className="flex items-baseline gap-2 p-3">
                  <span className="min-w-0 flex-1">
                    {line.productName}
                    {line.variantLabel === null ? '' : ` · ${line.variantLabel}`}
                    <span className="text-muted-foreground"> × {line.qty}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular">
                    {formatPHP(money(line.lineTotal))}
                  </span>
                </li>
              ))}
            </ul>
            <Totals quote={quote} />
            <Field
              id="notes"
              name="notes"
              label={t('checkout.notes')}
              defaultValue={contact.notes}
              placeholder={t('checkout.notesPlaceholder')}
            />
          </section>

          {/* Desktop submit; phones use the sticky bar. */}
          <button
            type="submit"
            name="intent"
            value="place"
            className="hidden h-12 rounded-full bg-primary text-sm font-semibold text-primary-foreground sm:block"
          >
            {t('checkout.placeOrder', { total: formatPHP(money(quote.grandTotal)) })}
          </button>

          <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:hidden">
            <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{t('cart.grandTotal')}</p>
                <p className="font-semibold">{formatPHP(money(quote.grandTotal))}</p>
              </div>
              <button
                type="submit"
                name="intent"
                value="place"
                className="h-12 shrink-0 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground"
              >
                {t('checkout.placeOrderShort')}
              </button>
            </div>
          </div>
        </form>
      </main>

      <StoreFooter />
    </>
  )
}

/**
 * Region → province → city → barangay.
 *
 * Province is skipped entirely when the region has none — NCR, plus the
 * independent cities. That is not a special case bolted on; `nextAddressLevel()`
 * treats an empty province list as "not applicable" rather than "unanswered", which
 * is what keeps a Metro Manila buyer from being stuck on a step with no options.
 */
function AddressCascade({
  address,
  options,
}: {
  address: Partial<CheckoutAddress>
  options: PsgcOptions
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3">
      <Select
        id="regionCode"
        name="regionCode"
        label={t('checkout.region')}
        value={address.regionCode ?? ''}
        units={options.regions}
        placeholder={t('checkout.selectRegion')}
      />

      {options.provinces.length > 0 && (
        <Select
          id="provinceCode"
          name="provinceCode"
          label={t('checkout.province')}
          value={address.provinceCode ?? ''}
          units={options.provinces}
          placeholder={t('checkout.selectProvince')}
        />
      )}

      <Select
        id="cityCode"
        name="cityCode"
        label={t('checkout.city')}
        value={address.cityCode ?? ''}
        units={options.cities}
        placeholder={t('checkout.selectCity')}
        disabled={options.cities.length === 0}
      />

      <Select
        id="barangayCode"
        name="barangayCode"
        label={t('checkout.barangay')}
        value={address.barangayCode ?? ''}
        units={options.barangays}
        placeholder={t('checkout.selectBarangay')}
        disabled={options.barangays.length === 0}
        hint={t('checkout.barangayHint')}
      />
    </div>
  )
}

function Select({
  id,
  name,
  label,
  value,
  units,
  placeholder,
  disabled = false,
  hint,
}: {
  id: string
  name: string
  label: string
  value: string
  units: { code: string; name: string }[]
  placeholder: string
  disabled?: boolean
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={value}
        disabled={disabled}
        // Once hydrated, choosing a level submits the form for the buyer instead of
        // making them find the button. Deliberately the *same* server round trip
        // the no-JavaScript path takes — enhancing the trigger rather than adding a
        // second way to fetch options, so the two cannot drift apart.
        onChange={(event) => {
          const form = event.currentTarget.form
          const submitter = form?.querySelector<HTMLButtonElement>('[data-cascade-next]')
          if (form !== null && form !== undefined && submitter !== null && submitter !== undefined) {
            form.requestSubmit(submitter)
          }
        }}
        className="h-11 rounded-lg border bg-background px-3 text-sm disabled:opacity-50"
      >
        <option value="">{placeholder}</option>
        {units.map((unit) => (
          <option key={unit.code} value={unit.code}>
            {unit.name}
          </option>
        ))}
      </select>
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Field({
  id,
  name,
  label,
  defaultValue,
  type = 'text',
  required = false,
  placeholder,
  hint,
  autoComplete,
  inputMode,
  invalid = false,
}: {
  id: string
  name: string
  label: string
  defaultValue: string
  type?: string
  required?: boolean
  placeholder?: string
  hint?: string
  autoComplete?: string
  inputMode?: 'text' | 'tel' | 'email' | 'numeric'
  invalid?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        aria-invalid={invalid || undefined}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(autoComplete === undefined ? {} : { autoComplete })}
        {...(inputMode === undefined ? {} : { inputMode })}
        className={
          invalid
            ? 'h-11 rounded-lg border border-destructive bg-background px-3 text-sm'
            : 'h-11 rounded-lg border bg-background px-3 text-sm'
        }
      />
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
