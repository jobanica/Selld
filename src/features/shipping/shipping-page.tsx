import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Truck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActiveTenant } from '@/features/tenancy/use-tenant'
import { formatPHP, parsePesos, type Centavos } from '@/lib/money'
import { cn } from '@/lib/utils'

import { RateEditor } from './rate-editor'
import {
  createZone,
  deleteZone,
  describeShippingError,
  fetchZones,
  seedPresets,
  type ShippingZone,
} from './shipping-api'
import { ZoneAreaEditor } from './zone-area-editor'

/**
 * Shipping configuration.
 *
 * The done-when for this phase is that a seller can express "₱80 Davao City, ₱150
 * Mindanao, ₱200 rest of PH, free over ₱2,000" without touching code. So the screen
 * is organised around that sentence: a list of zones in resolution order, each
 * showing what it covers and what it charges, with the catch-all pinned last and
 * labelled as the fallback.
 *
 * Resolution order is stated on the page rather than left implicit. A seller who
 * does not know that a city rule beats a region rule cannot predict what a buyer in
 * Davao will be charged, and will "fix" it by deleting the zone that was working.
 */
export function ShippingPage() {
  const { t } = useTranslation()
  const tenant = useActiveTenant()
  const queryClient = useQueryClient()

  const [newZoneName, setNewZoneName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const zones = useQuery({
    queryKey: ['shipping-zones', tenant.id],
    queryFn: () => fetchZones(tenant.id),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['shipping-zones', tenant.id] })

  const addZone = useMutation({
    mutationFn: (name: string) =>
      createZone({ tenantId: tenant.id, name, isDefault: (zones.data ?? []).length === 0 }),
    onSuccess: async () => {
      setNewZoneName('')
      setError(null)
      await invalidate()
    },
    onError: (cause) => setError(describeShippingError(cause)),
  })

  const removeZone = useMutation({
    mutationFn: (zoneId: string) => deleteZone(zoneId),
    onSuccess: invalidate,
    onError: (cause) => setError(describeShippingError(cause)),
  })

  const presets = useMutation({
    mutationFn: () =>
      seedPresets({
        tenantId: tenant.id,
        metro: parsePesos('80') as Centavos,
        rest: parsePesos('150') as Centavos,
        freeOver: null,
      }),
    onSuccess: invalidate,
    onError: (cause) => setError(describeShippingError(cause)),
  })

  const list = zones.data ?? []
  const hasDefault = list.some((zone) => zone.isDefault)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('shippingConfig.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('shippingConfig.intro')}</p>
      </header>

      {error !== null && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {t(`shippingConfig.error.${error}` as 'shippingConfig.error.unknown')}
        </p>
      )}

      {/*
        A store with no catch-all cannot quote anywhere it has not listed, which
        means buyers outside those areas simply cannot check out. Worth interrupting
        for.
      */}
      {list.length > 0 && !hasDefault && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {t('shippingConfig.noDefaultWarning')}
        </p>
      )}

      {zones.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : list.length === 0 ? (
        <Card>
          <CardHeader className="items-start gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Truck className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base">{t('shippingConfig.empty')}</CardTitle>
            <CardDescription>{t('shippingConfig.emptyBody')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => presets.mutate()} disabled={presets.isPending}>
              {t('shippingConfig.usePreset')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('shippingConfig.resolutionOrder')}</p>
          <ul className="flex flex-col gap-3">
            {list.map((zone) => (
              <li key={zone.id}>
                <ZoneCard
                  zone={zone}
                  expanded={expanded === zone.id}
                  onToggle={() => setExpanded(expanded === zone.id ? null : zone.id)}
                  onDelete={() => removeZone.mutate(zone.id)}
                  onChanged={invalidate}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('shippingConfig.addZone')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault()
              if (newZoneName.trim() === '') return
              addZone.mutate(newZoneName.trim())
            }}
          >
            <div className="flex-1">
              <Label htmlFor="zone-name" className="sr-only">
                {t('shippingConfig.zoneName')}
              </Label>
              <Input
                id="zone-name"
                value={newZoneName}
                placeholder={t('shippingConfig.zoneNamePlaceholder')}
                onChange={(event) => setNewZoneName(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={addZone.isPending || newZoneName.trim() === ''}>
              <Plus className="size-4" aria-hidden="true" />
              {t('shippingConfig.addZone')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function ZoneCard({
  zone,
  expanded,
  onToggle,
  onDelete,
  onChanged,
}: {
  zone: ShippingZone
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const rate = zone.rates[0]

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {zone.name}
              {zone.isDefault && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                  {t('shippingConfig.fallback')}
                </span>
              )}
            </CardTitle>
            {/* The zone read back as a sentence: what it covers, what it charges. */}
            <CardDescription className="mt-1">
              {zone.isDefault
                ? t('shippingConfig.coversEverywhereElse')
                : zone.areas.length === 0
                  ? t('shippingConfig.coversNothing')
                  : t('shippingConfig.coversCount', { count: zone.areas.length })}
              {' · '}
              {rate === undefined
                ? t('shippingConfig.noRate')
                : rate.rateType === 'weight_tiered'
                  ? t('shippingConfig.byWeight', { count: rate.tiers.length })
                  : formatPHP(rate.flat ?? (0 as Centavos))}
              {rate?.freeOver !== null && rate?.freeOver !== undefined
                ? ` · ${t('shippingConfig.freeOver', { amount: formatPHP(rate.freeOver) })}`
                : ''}
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-1">
            {/*
              Default size, not `sm`. `sm` is 36px and button-variants.ts reserves it
              for dense table rows; this is the control a seller taps one-handed to
              open a zone, so it takes the 44px minimum like everything else.
            */}
            <Button variant="ghost" onClick={onToggle}>
              {expanded ? t('shippingConfig.doneEditing') : t('shippingConfig.edit')}
            </Button>
            {!zone.isDefault && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('shippingConfig.deleteZone')}
                onClick={onDelete}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        {zone.areas.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {zone.areas.slice(0, expanded ? zone.areas.length : 6).map((area) => (
              <li
                key={area.id}
                className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {area.name}
              </li>
            ))}
            {!expanded && zone.areas.length > 6 && (
              <li className="px-1 text-xs text-muted-foreground">
                {t('shippingConfig.andMore', { count: zone.areas.length - 6 })}
              </li>
            )}
          </ul>
        )}
      </CardHeader>

      {expanded && (
        <CardContent className={cn('flex flex-col gap-6 border-t pt-4')}>
          {!zone.isDefault && <ZoneAreaEditor zone={zone} onChanged={onChanged} />}
          <RateEditor zone={zone} onChanged={onChanged} />
        </CardContent>
      )}
    </Card>
  )
}
