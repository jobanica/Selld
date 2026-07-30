# `src/features` — feature slices

One directory per feature (`orders/`, `catalog/`, `live-selling/`), each owning its
own components, hooks, and queries.

**Import rules**

- A feature may import from `src/core`, `src/lib`, and `src/components`.
- A feature must NOT import from another feature. If two features need the same
  thing, it belongs in `src/lib` (app-specific) or `src/core` (portable).
- React lives here, never in `src/core`.

The first slice lands in phase 1 with auth and tenancy.
