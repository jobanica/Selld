import { forwardRef, type InputHTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * `h-11` (44px) minimum touch target, and `text-base` on mobile because iOS
 * Safari zooms the whole viewport when a focused input's font is under 16px —
 * which throws off every subsequent tap on a checkout form.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base',
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm',
          'aria-[invalid=true]:border-destructive',
          className,
        )}
        {...props}
      />
    )
  },
)
