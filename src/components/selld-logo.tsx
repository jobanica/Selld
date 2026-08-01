/**
 * The Selld mark and wordmark.
 *
 * One component, because the logo was previously a generic `Store` glyph pasted
 * into six screens — the dashboard shell, sign-in, create-store, the onboarding
 * wizard, the reseller console. Six copies is six places to miss when the brand
 * moves.
 *
 * The mark is a shopping bag with an S cut through it, drawn from the brand
 * artwork. It is *not* the full artwork: the cart and the browser dots in the
 * source read as noise below about 64px, and this renders at 28px in a header
 * and 32px in a favicon. What survives at that size is the bag silhouette, the
 * handle, and the S — so that is what is drawn.
 *
 * `currentColor` is deliberately absent. The mark is a two-colour lockup and
 * inheriting a single colour would flatten the S into the bag.
 */

export function SelldMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role={title === undefined ? 'presentation' : 'img'}
      {...(title === undefined ? { 'aria-hidden': true } : {})}
    >
      {title !== undefined && <title>{title}</title>}
      <defs>
        {/* Matches the artwork: deeper at the lower left, brighter at the upper
            right. A flat fill loses the depth the bag reads from. */}
        <linearGradient id="selld-mark-fill" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#3730d8" />
          <stop offset="1" stopColor="#5b78f7" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="7.5" fill="url(#selld-mark-fill)" />

      {/*
        The S, as a stroked spine rather than two arcs. The first attempt drew
        it as a pair of half-annuli and rendered as a hook — an S is one
        continuous curve, and at 28px in a header the eye reads the curve, not
        the construction.

        No bag handle: the tile *is* the bag at this size, so a handle would
        have to sit outside it. What the artwork reads as below about 64px is
        the blue rounded square with a white S, which is exactly this.
      */}
      <path
        d="M20.2 12.1c0-2.3-2.1-3.6-4.5-3.6-2.7 0-4.9 1.5-4.9 3.8 0 2.3 2.1 3.3 5.2 4s5.2 1.7 5.2 4c0 2.3-2.2 3.8-4.9 3.8-2.4 0-4.5-1.3-4.5-3.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Mark plus wordmark.
 *
 * The `d` carries the accent block from the artwork. It is a span rather than
 * part of the SVG so it inherits the surrounding type — the wordmark has to sit
 * on the same baseline as whatever it is placed next to.
 */
export function SelldLogo({
  className,
  markClassName = 'size-7',
}: {
  className?: string
  markClassName?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <SelldMark className={`${markClassName} shrink-0`} />
      <span className="font-headline text-lg font-bold tracking-tight text-foreground">
        Sell<span className="text-primary">d</span>
      </span>
    </span>
  )
}
