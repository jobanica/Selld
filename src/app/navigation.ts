import {
  Banknote,
  BarChart3,
  Boxes,
  CreditCard,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Package,
  Radio,
  Settings,
  ShoppingBag,
  Store,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react'

import type { Translations } from '@/lib/i18n/locales/en'

type NavLabelKey = keyof Translations['nav']

export interface NavItem {
  to: string
  labelKey: NavLabelKey
  icon: LucideIcon
  /** The phase that makes this route real. Rendered as a hint until then. */
  phase: number
}

export interface NavSection {
  titleKey: NavLabelKey
  items: NavItem[]
}

/**
 * Dashboard navigation.
 *
 * Every destination in the build spec is listed from phase 0 so the information
 * architecture is settled before features land — reshuffling navigation later is
 * how sellers lose the muscle memory they built. Routes not yet implemented
 * render a "coming soon" placeholder rather than 404ing.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    titleKey: 'sectionMain',
    items: [
      { to: '/', labelKey: 'dashboard', icon: LayoutDashboard, phase: 0 },
      { to: '/orders', labelKey: 'orders', icon: ShoppingBag, phase: 9 },
    ],
  },
  {
    titleKey: 'sectionSell',
    items: [
      { to: '/products', labelKey: 'products', icon: Package, phase: 3 },
      { to: '/inventory', labelKey: 'inventory', icon: Boxes, phase: 4 },
      { to: '/live', labelKey: 'liveSelling', icon: Radio, phase: 13 },
      { to: '/shipping', labelKey: 'shipping', icon: Truck, phase: 7 },
      { to: '/payments', labelKey: 'payments', icon: CreditCard, phase: 8 },
      { to: '/cod', labelKey: 'cod', icon: Banknote, phase: 12 },
    ],
  },
  {
    titleKey: 'sectionGrow',
    items: [
      { to: '/customers', labelKey: 'customers', icon: Users, phase: 15 },
      { to: '/inbox', labelKey: 'inbox', icon: MessageCircle, phase: 14 },
      { to: '/broadcasts', labelKey: 'broadcasts', icon: Megaphone, phase: 16 },
      { to: '/marketplaces', labelKey: 'marketplaces', icon: Store, phase: 17 },
      { to: '/analytics', labelKey: 'analytics', icon: BarChart3, phase: 18 },
      { to: '/settings', labelKey: 'settings', icon: Settings, phase: 2 },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items)
