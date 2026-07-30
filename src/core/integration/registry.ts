/**
 * Generic provider registry.
 *
 * All four provider families (couriers, payments, SMS, marketplaces) share one
 * lifecycle: register implementations at startup, resolve by id at call time,
 * fail loudly on an unknown id. Implementing that once keeps the families
 * consistent and makes adding a fifth trivial.
 */

export interface Identified<Id extends string> {
  readonly id: Id
}

export class ProviderRegistry<Id extends string, T extends Identified<Id>> {
  private readonly providers = new Map<Id, T>()
  private readonly familyName: string

  constructor(familyName: string) {
    this.familyName = familyName
  }

  register(provider: T): this {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `${this.familyName} provider "${provider.id}" is already registered. ` +
          'Registering twice usually means two different credential sets are competing.',
      )
    }
    this.providers.set(provider.id, provider)
    return this
  }

  /** Resolve a provider, throwing a useful error when it is missing. */
  get(id: Id): T {
    const provider = this.providers.get(id)
    if (!provider) {
      const known = this.ids()
      throw new Error(
        `Unknown ${this.familyName} provider "${id}". Registered: ${known.length > 0 ? known.join(', ') : '(none)'}`,
      )
    }
    return provider
  }

  find(id: Id): T | undefined {
    return this.providers.get(id)
  }

  has(id: Id): boolean {
    return this.providers.has(id)
  }

  ids(): Id[] {
    return [...this.providers.keys()]
  }

  all(): T[] {
    return [...this.providers.values()]
  }

  /** Test seam. */
  clear(): void {
    this.providers.clear()
  }
}
