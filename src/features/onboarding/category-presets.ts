/**
 * What Filipino social sellers actually sell.
 *
 * Chosen from real FB/IG/TikTok seller inventory rather than a generic ecommerce
 * taxonomy — the avatar sells skincare and RTW, and a list starting with
 * "Electronics & Computers" tells her this product was not built for her.
 *
 * The selection is stored in `tenant_settings['catalog.presets']`. Phase 3 seeds
 * actual `categories` rows from it; nothing here writes to the catalog yet.
 */

export interface CategoryPreset {
  /** Stable key. Persisted, so never rename one — add a new key instead. */
  key: string
  /** Emoji, kept as a plain string so there is no icon dependency. */
  emoji: string
  labelEn: string
  labelTl: string
  /** Categories phase 3 will create for this preset. */
  categories: string[]
}

export const CATEGORY_PRESETS: CategoryPreset[] = [
  {
    key: 'skincare',
    emoji: '🧴',
    labelEn: 'Skincare & beauty',
    labelTl: 'Skincare at beauty',
    categories: ['Face', 'Body', 'Sunscreen', 'Make-up', 'Sets & bundles'],
  },
  {
    key: 'rtw',
    emoji: '👗',
    labelEn: 'Clothing (RTW)',
    labelTl: 'Damit (RTW)',
    categories: ['Tops', 'Bottoms', 'Dresses', 'Terno & sets', 'Plus size'],
  },
  {
    key: 'bags-shoes',
    emoji: '👟',
    labelEn: 'Bags & shoes',
    labelTl: 'Bags at sapatos',
    categories: ['Bags', 'Shoes', 'Sandals', 'Wallets'],
  },
  {
    key: 'accessories',
    emoji: '💎',
    labelEn: 'Accessories & jewelry',
    labelTl: 'Accessories at alahas',
    categories: ['Earrings', 'Necklaces', 'Rings', 'Watches', 'Hair accessories'],
  },
  {
    key: 'food',
    emoji: '🍯',
    labelEn: 'Food & delicacies',
    labelTl: 'Pagkain at pasalubong',
    categories: ['Snacks', 'Frozen', 'Pasalubong', 'Baked goods', 'Drinks'],
  },
  {
    key: 'home',
    emoji: '🏠',
    labelEn: 'Home & living',
    labelTl: 'Home at living',
    categories: ['Kitchen', 'Storage', 'Decor', 'Bedding', 'Cleaning'],
  },
  {
    key: 'baby',
    emoji: '🍼',
    labelEn: 'Baby & kids',
    labelTl: 'Baby at bata',
    categories: ['Clothing', 'Feeding', 'Toys', 'Diapers & care'],
  },
  {
    key: 'gadgets',
    emoji: '🎧',
    labelEn: 'Gadgets & accessories',
    labelTl: 'Gadgets at accessories',
    categories: ['Phone accessories', 'Audio', 'Chargers & cables', 'Wearables'],
  },
  {
    key: 'health',
    emoji: '💪',
    labelEn: 'Health & supplements',
    labelTl: 'Health at supplements',
    categories: ['Supplements', 'Coffee & drinks', 'Personal care'],
  },
  {
    key: 'pets',
    emoji: '🐾',
    labelEn: 'Pet supplies',
    labelTl: 'Pang-alagang hayop',
    categories: ['Food', 'Toys', 'Grooming', 'Accessories'],
  },
  {
    key: 'preloved',
    emoji: '♻️',
    labelEn: 'Preloved & thrift',
    labelTl: 'Preloved at ukay',
    categories: ['Clothing', 'Bags', 'Shoes', 'Bundles'],
  },
  {
    key: 'other',
    emoji: '📦',
    labelEn: 'Something else',
    labelTl: 'Iba pa',
    categories: ['All products'],
  },
]

export const PRESET_KEYS = CATEGORY_PRESETS.map((preset) => preset.key)

export function isPresetKey(value: string): boolean {
  return PRESET_KEYS.includes(value)
}

export function presetLabel(preset: CategoryPreset, locale: string): string {
  return locale === 'tl' ? preset.labelTl : preset.labelEn
}

/** Categories phase 3 should create, de-duplicated across the chosen presets. */
export function categoriesForPresets(keys: readonly string[]): string[] {
  const selected = CATEGORY_PRESETS.filter((preset) => keys.includes(preset.key))
  return [...new Set(selected.flatMap((preset) => preset.categories))]
}
