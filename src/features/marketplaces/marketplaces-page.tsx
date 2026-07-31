import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Link2, RefreshCw, Store } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatManilaDateTime } from '@/lib/time/manila'

import {
  connectShop,
  describeMarketplaceError,
  fetchMarketplaceOverview,
  fetchVariantOptions,
  mapListing,
  resolveIssue,
  setSync,
  syncNow,
  type MarketplaceConnection,
} from './marketplaces-api'

/**
 * Marketplace sync.
 *
 * The screen is built around one question — **is every listing linked** — because
 * that is the only thing standing between a seller and the 11am double-sell. A
 * connected shop with nine of twelve listings mapped is three listings quietly
 * selling stock Selld does not know about, so "9 / 12" is the largest thing on
 * each card and the unmapped ones sort to the top of the list.
 *
 * The queue underneath is the same idea in the other direction: work the seller
 * has to do, stated as work rather than logged as an error.
 */
export function MarketplacesPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [platform, setPlatform] = useState('shopee')
  const [shopId, setShopId] = useState('')
  const [shopName, setShopName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const overview = useQuery({
    queryKey: ['marketplaces', tenant.id],
    queryFn: () => fetchMarketplaceOverview(tenant.id),
    // The push worker moves numbers on its own; a screen that only updated when
    // the seller reloaded would show a stale "last pushed" for as long as they
    // left it open.
    refetchInterval: 10_000,
  })

  const variants = useQuery({
    queryKey: ['variant-options', tenant.id],
    queryFn: () => fetchVariantOptions(tenant.id),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketplaces', tenant.id] })

  const connect = useMutation({
    mutationFn: () =>
      connectShop({ tenantId: tenant.id, platform, shopId, shopName }),
    onSuccess: async () => {
      setShopId('')
      setShopName('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeMarketplaceError(cause)),
  })

  const toggle = useMutation({
    mutationFn: (input: { connectionId: string; syncStock?: boolean; syncOrders?: boolean }) =>
      setSync(input),
    onSuccess: invalidate,
    onError: (cause) => setError(describeMarketplaceError(cause)),
  })

  const map = useMutation({
    mutationFn: (input: { listingId: string; variantId: string | null }) => mapListing(input),
    onSuccess: async () => {
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeMarketplaceError(cause)),
  })

  const resolve = useMutation({
    mutationFn: (issueId: string) => resolveIssue(issueId),
    onSuccess: invalidate,
    onError: (cause) => setError(describeMarketplaceError(cause)),
  })

  const run = useMutation({
    mutationFn: (input: { connectionId: string; action: 'import' | 'push' | 'pull' }) =>
      syncNow(input.connectionId, input.action),
    onMutate: (input) => setBusy(`${input.connectionId}:${input.action}`),
    onSuccess: async () => {
      setBusy(null)
      setError(null)
      await invalidate()
    },
    onError: (cause) => {
      setBusy(null)
      setError(describeMarketplaceError(cause))
    },
  })

  const data = overview.data
  const connections = data?.connections ?? []
  const listings = data?.listings ?? []
  const issues = data?.issues ?? []

  const statusLabel = (connection: MarketplaceConnection): string =>
    connection.status === 'connected'
      ? t('marketplaces.statusConnected')
      : connection.status === 'expired'
        ? t('marketplaces.statusExpired')
        : connection.status === 'error'
          ? t('marketplaces.statusError')
          : t('marketplaces.statusDisconnected')

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-headline text-2xl font-bold tracking-tight">
          {t('marketplaces.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('marketplaces.subtitle')}</p>
      </header>

      {error !== null && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {t(error as 'marketplaces.errorUnknown')}
        </p>
      )}

      {/* The queue first: it is work, and work that is below the fold is work
          nobody does. */}
      {issues.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" aria-hidden="true" />
              {t('marketplaces.issuesTitle', { count: issues.length })}
            </CardTitle>
            <CardDescription>{t('marketplaces.issuesSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul id="marketplace-issues" className="flex flex-col divide-y">
              {issues.map((issue) => (
                <li key={issue.id} className="flex flex-wrap items-center gap-2 py-3">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                    {t(`marketplaces.issue_${issue.kind}` as 'marketplaces.issue_unmapped_sku')}
                  </span>
                  {/* Translated from `kind`, not read from the row. The database
                      stores an English sentence so a support ticket and a log
                      line have one, but rendering it here would leave the queue
                      in English on a Taglish screen — which is hard rule 5, and
                      is exactly how it gets broken: the string is *already*
                      written by the time anyone thinks about the locale. */}
                  <span className="text-sm">
                    {t(
                      `marketplaces.issueMessage_${issue.kind}` as 'marketplaces.issueMessage_unmapped_sku',
                    )}
                  </span>
                  {/* The SKU, not the row id. `reference` is a listing uuid for
                      half these kinds, and a uuid tells a seller nothing about
                      which of their products is the one not selling. */}
                  {(() => {
                    const label =
                      (typeof issue.detail?.sku === 'string' && issue.detail.sku !== ''
                        ? issue.detail.sku
                        : typeof issue.detail?.name === 'string'
                          ? issue.detail.name
                          : null) ?? null
                    return label === null ? null : (
                      <span className="font-mono text-xs text-muted-foreground">{label}</span>
                    )
                  })()}
                  <Button
                    type="button"
                    variant="outline"
                    className="ml-auto h-11"
                    onClick={() => resolve.mutate(issue.id)}
                  >
                    {t('marketplaces.issueDismiss')}
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {connections.map((connection) => (
        <Card key={connection.id}>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Store className="size-4" aria-hidden="true" />
              {connection.shopName ?? connection.platform}
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal">
                {statusLabel(connection)}
              </span>
            </CardTitle>
            <CardDescription>
              {t('marketplaces.shopLine', {
                platform: connection.platform,
                shopId: connection.shopId,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* The number that matters. */}
            <div id="marketplace-ratio" className="rounded-lg bg-muted p-3">
              <p className="text-2xl font-bold tabular-nums">
                {t('marketplaces.mappedRatio', {
                  mapped: connection.mapped,
                  total: connection.listings,
                })}
              </p>
              <p className="text-sm">
                {connection.mapped < connection.listings
                  ? t('marketplaces.mappedWarning', {
                      count: connection.listings - connection.mapped,
                    })
                  : t('marketplaces.mappedAllGood')}
              </p>
              <p className="text-xs text-muted-foreground">
                {connection.lastStockPushAt === null
                  ? t('marketplaces.neverPushed')
                  : t('marketplaces.lastPushed', {
                      when: formatManilaDateTime(connection.lastStockPushAt),
                    })}
              </p>
              {connection.lastError !== null && (
                <p className="mt-1 text-xs text-destructive">{connection.lastError}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={connection.syncStock ? 'default' : 'outline'}
                className="h-11"
                onClick={() =>
                  toggle.mutate({
                    connectionId: connection.id,
                    syncStock: !connection.syncStock,
                  })
                }
              >
                {connection.syncStock
                  ? t('marketplaces.stockSyncOn')
                  : t('marketplaces.stockSyncOff')}
              </Button>
              <Button
                type="button"
                variant={connection.syncOrders ? 'default' : 'outline'}
                className="h-11"
                onClick={() =>
                  toggle.mutate({
                    connectionId: connection.id,
                    syncOrders: !connection.syncOrders,
                  })
                }
              >
                {connection.syncOrders
                  ? t('marketplaces.orderSyncOn')
                  : t('marketplaces.orderSyncOff')}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={busy !== null}
                onClick={() => run.mutate({ connectionId: connection.id, action: 'import' })}
              >
                <RefreshCw className="mr-2 size-4" aria-hidden="true" />
                {busy === `${connection.id}:import`
                  ? t('marketplaces.importing')
                  : t('marketplaces.importListings')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Listings, unmapped first — the ones needing attention are the ones a
          seller opened this screen for. */}
      {listings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" aria-hidden="true" />
              {t('marketplaces.listingsTitle')}
            </CardTitle>
            <CardDescription>{t('marketplaces.listingsSubtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul id="marketplace-listings" className="flex flex-col divide-y">
              {listings.map((listing) => (
                <li key={listing.id} className="flex flex-col gap-2 py-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{listing.name ?? listing.externalItemId}</span>
                    {listing.externalSku !== null && (
                      <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs">
                        {listing.externalSku}
                      </span>
                    )}
                    <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                      {listing.variantId === null
                        ? t('marketplaces.notLinked')
                        : t('marketplaces.sellableNow', { count: listing.sellable ?? 0 })}
                    </span>
                  </span>
                  <select
                    aria-label={t('marketplaces.linkTo')}
                    className="h-11 rounded-lg border bg-background px-3 text-sm"
                    value={listing.variantId ?? ''}
                    onChange={(event) =>
                      map.mutate({
                        listingId: listing.id,
                        variantId: event.target.value === '' ? null : event.target.value,
                      })
                    }
                  >
                    <option value="">{t('marketplaces.notLinkedOption')}</option>
                    {(variants.data ?? []).map((variant) => (
                      <option key={variant.id} value={variant.id}>
                        {variant.label}
                      </option>
                    ))}
                  </select>
                  {listing.lastPushedAt !== null && (
                    <span className="text-xs text-muted-foreground">
                      {t('marketplaces.lastToldThem', {
                        count: listing.lastPushedStock ?? 0,
                        when: formatManilaDateTime(listing.lastPushedAt),
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('marketplaces.connectTitle')}</CardTitle>
          <CardDescription>{t('marketplaces.connectSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mp-platform">{t('marketplaces.platformLabel')}</Label>
            <select
              id="mp-platform"
              className="h-11 rounded-lg border bg-background px-3 text-sm"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
            >
              <option value="shopee">Shopee</option>
              <option value="lazada">Lazada</option>
              <option value="tiktok">TikTok Shop</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mp-shop-id">{t('marketplaces.shopIdLabel')}</Label>
            <Input
              id="mp-shop-id"
              value={shopId}
              placeholder="123456789"
              onChange={(event) => setShopId(event.target.value.trim())}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mp-shop-name">{t('marketplaces.shopNameLabel')}</Label>
            <Input
              id="mp-shop-name"
              value={shopName}
              onChange={(event) => setShopName(event.target.value)}
            />
          </div>
          <Button
            type="button"
            className="h-11 w-full sm:w-auto"
            disabled={shopId.trim() === '' || connect.isPending}
            onClick={() => connect.mutate()}
          >
            {t('marketplaces.connectAction')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('marketplaces.connectHint')}</p>
        </CardContent>
      </Card>
    </div>
  )
}
