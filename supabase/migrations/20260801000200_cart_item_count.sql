-- ---------------------------------------------------------------------------
-- How many things are in this cart, and nothing else
-- ---------------------------------------------------------------------------
-- The cart badge on a catalog page had no number in it, ever. `cartCount` was
-- passed only on the cart and checkout routes; the home and product renders left
-- it at its default of 0, so a buyer who tapped "Add to cart" was returned to the
-- product page and shown an empty cart. The thing they had just done looked like
-- it had not happened, and the honest reading of that is "it did not work".
--
-- `cart_view()` already answers this, and answers far too much of it: it prices
-- the whole cart, resolves a shipping zone and applies a discount, on every
-- catalog page load, to render a number between 1 and 99. This is the cheap half.
--
-- Same boundary as every other cart function: the token is the credential, anon
-- has no grant on `cart_items`, and this is `SECURITY DEFINER` because that is
-- what makes the table unreachable except through a function that checked a token
-- first. It returns one integer — no ids, no prices, no product names — so a
-- guessed token buys a count and nothing worth having.
create or replace function public.cart_item_count(p_token text)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  -- `cart_id_for_token` is null for an unknown, converted or expired cart, and
  -- summing over no rows is null, so a stale cookie reads as an empty cart rather
  -- than as an error on a page that has nothing to do with the cart.
  select coalesce((
    select sum(i.qty)::int
    from public.cart_items i
    where i.cart_id = public.cart_id_for_token(p_token)
  ), 0);
$$;

comment on function public.cart_item_count(text) is
  'Total quantity in the cart behind this token, or 0. The badge, without pricing the cart.';

-- PUBLIC first: Postgres grants EXECUTE on every new function to PUBLIC at CREATE
-- time, and revoking from a named role does not take back what it holds through
-- PUBLIC.
revoke all on function public.cart_item_count(text) from public;
grant execute on function public.cart_item_count(text) to anon, authenticated, service_role;
