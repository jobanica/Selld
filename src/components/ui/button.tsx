import { Slot } from '@radix-ui/react-slot'
import { forwardRef, type ButtonHTMLAttributes } from 'react'

import { buttonVariants, type ButtonVariantProps } from '@/components/ui/button-variants'
import { cn } from '@/lib/utils'

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonVariantProps {
  asChild?: boolean
}

/**
 * `forwardRef` is REQUIRED here, not stylistic.
 *
 * Radix primitives that take `asChild` (DropdownMenuTrigger, TooltipTrigger,
 * DialogTrigger, PopoverTrigger…) pass a ref to their child so floating-ui can
 * measure the anchor element. A function component that silently drops the ref
 * leaves the popper unpositioned — it renders at `translate(0, -200%)`, off
 * screen, and looks like the menu simply does not open.
 *
 * Current shadcn/ui source omits `forwardRef` because React 19 accepts `ref` as
 * an ordinary prop. This project is pinned to React 18, where it does not — so
 * any UI primitive used with `asChild` must forward its ref explicitly.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button'
  return (
    <Component ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  )
})
