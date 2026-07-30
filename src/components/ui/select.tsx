import { ChevronDown } from 'lucide-react'
import { forwardRef, type SelectHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * A native `<select>`, deliberately.
 *
 * A custom combobox looks better on desktop and is worse on the devices that
 * matter here: Android and iOS render a native wheel/list for `<select>` that is
 * faster to operate one-handed, searchable by typing on Android, and immune to the
 * scroll-jacking a portalled popover suffers inside a mobile form. Some of these
 * lists run to 140+ barangays — the native picker handles that far better than a
 * div with `overflow-y: auto`.
 *
 * Phase 6 checkout uses the same control for the same reason.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            'flex h-11 w-full appearance-none rounded-md border border-input bg-background',
            'px-3 py-2 pr-9 text-base focus-visible:outline-none focus-visible:ring-2',
            'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm',
            'aria-[invalid=true]:border-destructive',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 opacity-60"
          aria-hidden="true"
        />
      </div>
    )
  },
)
