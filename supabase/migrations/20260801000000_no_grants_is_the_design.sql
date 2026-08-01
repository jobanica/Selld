-- The absence of a grant, made explicit.
--
-- Nine tables in this schema have row level security enabled and *no policy at
-- all*. That is not an oversight — it is the strongest statement the schema can
-- make. A policy is a rule about which rows a caller may see; no policy means
-- there is no such rule to get wrong, and the only thing that can read the table
-- is a `SECURITY DEFINER` function that was written to. Between them these nine
-- hold every page access token, every marketplace token, the cross-tenant risk
-- pool, the platform's own secrets, and the row that says who is a platform
-- admin.
--
-- RLS closes them to `anon` and `authenticated`. It does not close them to
-- `service_role`, which carries BYPASSRLS — for that role the control was always
-- meant to be the other one: no grant. Phase 0 now stops the image handing out
-- table privileges to the two roles a browser can hold, but it deliberately
-- leaves `service_role` alone, because that role legitimately reads tables
-- through invoker-rights functions our own server calls (`marketplace_sellable`
-- sums `available_stock()`; `quote_shipping` reads the zone tables), and a blanket
-- revoke there is how phase 8 broke the payment webhook for a whole phase.
--
-- So the revoke is written out here, one table at a time, rather than swept up by
-- a loop over "RLS on and no policy". A table that joins this list should have to
-- be named by somebody who thought about it.
--
-- This has to be its own migration because a privilege cannot be revoked from a
-- table that does not exist yet, and these are created across phases 12 to 20.

-- Phase 12 — the cross-tenant risk pool. There is no tenant column on the
-- aggregate and no way back to one; a reader would be reading every store's
-- delivery history at once.
revoke all on public.buyer_risk_signals       from anon, authenticated, service_role;
revoke all on public.buyer_risk_contributions from anon, authenticated, service_role;

-- Phase 14 — a page access token can post as the seller, read their inbox and
-- message their customers. `social_accounts_safe` derives "connected",
-- "expired" and "subscribed" without carrying it.
revoke all on public.social_accounts          from anon, authenticated, service_role;

-- Phase 16 — a per-click log with timestamps is a browsing history, and nothing
-- in the product needs to read one row of it.
revoke all on public.short_link_clicks        from anon, authenticated, service_role;

-- Phase 17 — same class of secret as a page access token.
-- `marketplace_connections_safe` is the readable half. The queue is internal
-- bookkeeping for the push loop, which reaches it through a definer.
revoke all on public.marketplace_connections  from anon, authenticated, service_role;
revoke all on public.marketplace_stock_queue  from anon, authenticated, service_role;

-- Phase 19 — the other tables hold a secret; this one holds *authority*. A table
-- a client can write is a table that grants its own membership.
revoke all on public.platform_admins          from anon, authenticated, service_role;
revoke all on public.platform_secrets         from anon, authenticated, service_role;

-- Phase 20 — the rate limiter's own counters. `rate_limit_hit()` is the only
-- thing that should ever touch them; a caller that could edit the count could
-- lift its own limit.
revoke all on public.rate_limit_counters      from anon, authenticated, service_role;
