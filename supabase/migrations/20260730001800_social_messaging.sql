-- ===========================================================================
-- Phase 14 — Messenger & social integration
-- ===========================================================================
--
-- Filipino social commerce happens in comments and DMs. A buyer sees a post,
-- comments "how much po", and waits — and the seller answers that same question
-- forty times a day, by hand, from a phone, while doing something else.
--
-- **Done when:** a comment on any post triggers a DM with the store link within
-- five seconds.
--
-- ## The shape of it
--
-- `social_accounts`  a connected Facebook Page or Instagram account
-- `message_threads`  one conversation with one person, and its messaging window
-- `messages`         every message either way, deduplicated on the platform's id
-- `auto_replies`     keyword rules the seller writes
-- `post_comments`    comments on ordinary posts, and what was done about each
--
-- ## The one rule that is not ours to bend
--
-- Facebook lets a page send a **standard** message only within 24 hours of the
-- person's last message. Outside that window a send needs a *message tag*, and the
-- tags are narrow and specific: a purchase update, a confirmed event, an account
-- change. Using one for marketing is a policy violation, and the penalty is the
-- page's messaging permission — which for a seller whose entire business runs
-- through Messenger is the business.
--
-- So the window is enforced *in the database*, not remembered in the application:
-- `message_send_allowed()` is the only way anything gets sent, and it refuses.
-- A rule that lives in an `if` statement in one code path is a rule that the second
-- code path does not have.

-- ---------------------------------------------------------------------------
-- Connected accounts
-- ---------------------------------------------------------------------------
/**
 * A Facebook Page or Instagram professional account the seller has connected.
 *
 * The page access token is encrypted at rest with a key held in the *server's*
 * environment, exactly like phase 10's courier credentials and for the same threat
 * model: a stolen database dump is useless without the key. It is a far more
 * dangerous secret than a courier's API key — a page token can post as the seller,
 * read their inbox, and message their customers — so it gets the same treatment and
 * no `select` grant at all.
 *
 * `ig_user_id` hangs off the page because that is how Instagram works: an IG
 * professional account is reached through the Page it is linked to, with the same
 * token.
 */
create table public.social_accounts (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  platform text not null check (platform in ('facebook', 'instagram')),
  /** The Page id. Instagram accounts are reached through their Page. */
  page_id   text not null,
  page_name text,
  ig_user_id text,

  /** Encrypted with the key in the server's environment. No read grant. */
  token_encrypted bytea,
  /** What the token is actually allowed to do, as Facebook granted it. */
  scopes text[] not null default '{}',
  token_expires_at timestamptz,

  is_active boolean not null default true,
  /** Whether Facebook is actually delivering webhooks for this page. */
  webhook_subscribed boolean not null default false,

  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (tenant_id, id)
);

-- One page belongs to one store. Two tenants subscribing to the same page would
-- each auto-reply to every comment, and the buyer would get two DMs from what
-- looks like one shop.
create unique index social_accounts_page_idx
  on public.social_accounts (platform, page_id) where is_active;
create index social_accounts_tenant_idx on public.social_accounts (tenant_id);

create trigger social_accounts_touch
  before update on public.social_accounts
  for each row execute function public.set_updated_at();

/**
 * What a seller may see about their own connection.
 *
 * Owner-run rather than `security_invoker`, for the phase-8 reason: an invoker's
 * -rights view cannot read `token_encrypted` when the caller has no grant on it,
 * and deriving "is this connected" from a column nobody can select is the entire
 * point of the view.
 */
create or replace view public.social_accounts_safe
with (security_invoker = off) as
select
  a.id, a.tenant_id, a.platform, a.page_id, a.page_name, a.ig_user_id,
  a.scopes, a.token_expires_at, a.is_active, a.webhook_subscribed,
  a.connected_at,
  (a.token_encrypted is not null) as has_token,
  -- A token Facebook has already expired is worse than no token: everything
  -- silently stops and the seller's inbox just goes quiet.
  (a.token_expires_at is not null and a.token_expires_at < now()) as token_expired
from public.social_accounts a
where public.is_tenant_member(a.tenant_id);

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
/**
 * One conversation with one person, on one page.
 *
 * `last_inbound_at` is the most important column in this migration. Facebook's
 * standard messaging window runs 24 hours from the person's *last message to the
 * page* — not from the page's last reply, and not from when the thread was created.
 * Every send decision reads this.
 *
 * `psid` is page-scoped: the same human messaging two different Pages is two
 * different ids, and there is deliberately no way to correlate them. That is also
 * why the customer link is per tenant.
 */
create table public.message_threads (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  social_account_id uuid not null,

  platform text not null check (platform in ('facebook', 'instagram')),
  /** Page-scoped user id. Unique per page, meaningless anywhere else. */
  psid text not null,
  participant_name text,

  customer_id uuid,

  /** When the *person* last wrote. The 24-hour window counts from here. */
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  last_message_at  timestamptz,
  last_snippet     text,

  unread_count int not null default 0 check (unread_count >= 0),
  status text not null default 'open' check (status in ('open', 'closed')),

  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (social_account_id, psid),
  foreign key (tenant_id, social_account_id)
    references public.social_accounts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id)
    references public.customers (tenant_id, id) on delete set null (customer_id)
);

create index message_threads_tenant_idx
  on public.message_threads (tenant_id, last_message_at desc nulls last);
create index message_threads_unread_idx
  on public.message_threads (tenant_id, status) where unread_count > 0;

/**
 * Every message, both directions.
 *
 * `external_id` is the platform's own message id and the idempotency boundary —
 * Facebook redelivers, and a redelivered inbound message that reset the 24-hour
 * window would be a small lie in the seller's favour, which is exactly the kind of
 * lie that gets a page's messaging permission revoked.
 *
 * `tag` records which message tag a send was made under, or null for a standard
 * in-window message. Kept because "why did you message this person 40 hours after
 * they last wrote" is a question with an auditable answer or it is a violation.
 */
create table public.messages (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  thread_id uuid not null,

  direction text not null check (direction in ('in', 'out')),
  /** The platform's message id. Synthetic for a send we have not confirmed. */
  external_id text,

  body text,
  attachments jsonb,

  /** Null for a standard in-window message; otherwise the tag it was sent under. */
  tag text,
  /** What produced it: a person, a keyword rule, or the comment auto-reply. */
  source text not null default 'agent'
    check (source in ('user', 'agent', 'auto_reply', 'comment_reply', 'system')),

  status text not null default 'sent'
    check (status in ('sent', 'delivered', 'read', 'failed', 'blocked')),
  error text,

  sent_at    timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  foreign key (tenant_id, thread_id)
    references public.message_threads (tenant_id, id) on delete cascade
);

create index messages_thread_idx on public.messages (thread_id, sent_at desc);
-- Idempotency for inbound. Partial, because an outbound message has no platform id
-- until the Send API answers, and several may briefly share a null.
create unique index messages_external_idx
  on public.messages (thread_id, external_id) where external_id is not null;

-- ---------------------------------------------------------------------------
-- Keyword auto-replies
-- ---------------------------------------------------------------------------
/**
 * "PRICE" -> the store link. The seller's own rules, in their own words.
 *
 * `priority` decides when two rules both match, and the seller sets it — because
 * only they know that "order" should beat "or". Matching is on whole words by
 * default, which is what stops a rule for `cod` from firing on `codigo`.
 *
 * Deliberately not a chatbot. A rule that answers the four questions a seller
 * answers forty times a day is worth more than one that tries to hold a
 * conversation and gets it wrong in front of a customer.
 */
create table public.auto_replies (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  /** What to look for. Case-insensitive; matched per `match_type`. */
  keyword    text not null check (length(btrim(keyword)) between 1 and 60),
  match_type text not null default 'word' check (match_type in ('word', 'contains', 'exact')),

  /** Supports {{storeName}}, {{storeUrl}} and {{trackUrl}}. */
  body text not null check (length(btrim(body)) between 1 and 900),

  is_active boolean not null default true,
  priority  int not null default 0,

  /** Where it applies. A comment reply and a DM reply are different registers. */
  channel text not null default 'both' check (channel in ('message', 'comment', 'both')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tenant_id, id)
);

create index auto_replies_tenant_idx
  on public.auto_replies (tenant_id, priority desc) where is_active;

create trigger auto_replies_touch
  before update on public.auto_replies
  for each row execute function public.set_updated_at();

/**
 * A comment on an ordinary post, and what was done about it.
 *
 * Separate from phase 13's `live_comments` on purpose. A live comment is a *claim*
 * that reserves stock against a session's board; this is a stranger asking a
 * question under a photo, and the answer is a public reply plus a private message.
 * Merging them would mean one table where half the rows have a session and half do
 * not, and every query would have to know which half it was looking at.
 *
 * The two "replied" columns are what make the classic play idempotent: Facebook
 * redelivers, and a buyer who gets the same DM four times blocks the page.
 */
create table public.post_comments (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  social_account_id uuid not null,

  post_id    text not null,
  comment_id text not null,
  parent_id  text,

  psid        text not null,
  author_name text,
  body        text not null,

  replied_publicly boolean not null default false,
  replied_privately boolean not null default false,
  /** Why no DM was sent, when none was: no rule matched, no token, blocked. */
  private_reply_error text,

  created_at timestamptz not null default now(),

  unique (tenant_id, id),
  unique (social_account_id, comment_id),
  foreign key (tenant_id, social_account_id)
    references public.social_accounts (tenant_id, id) on delete cascade
);

create index post_comments_tenant_idx
  on public.post_comments (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The 24-hour window
-- ---------------------------------------------------------------------------
/**
 * Which message tags exist, and what each is actually for.
 *
 * A table rather than a CHECK constraint, because the seller-facing UI has to
 * explain them — a tag chosen because it was first in the dropdown is a policy
 * violation waiting to happen, and the penalty is the page's messaging permission.
 *
 * `HUMAN_AGENT` is the widest (seven days) and the most conditional: it is for a
 * *person* replying, not an automation, and Facebook grants it separately.
 */
create table public.message_tags (
  tag text primary key,
  /** How long after the last inbound message this tag remains usable. */
  window_hours int,
  description text not null,
  /** Whether an automated send may use it. `HUMAN_AGENT` may not. */
  automation_allowed boolean not null default true
);

insert into public.message_tags (tag, window_hours, description, automation_allowed) values
  ('CONFIRMED_EVENT_UPDATE', null,
   'A reminder about an event the person already registered for.', true),
  ('POST_PURCHASE_UPDATE', null,
   'An update about a purchase they already made — shipped, delivered, delayed.', true),
  ('ACCOUNT_UPDATE', null,
   'A change to their account that is not promotional.', true),
  ('HUMAN_AGENT', 168,
   'A human is replying. Seven days, and never for an automated message.', false);

alter table public.message_tags enable row level security;
create policy "Anyone signed in reads the tags" on public.message_tags
  for select to authenticated using (true);
grant select on public.message_tags to authenticated;

/**
 * May we send to this thread, and how?
 *
 * The single decision point. Everything that sends goes through it, so the rule
 * exists once rather than once per code path — and the second code path is the one
 * that gets it wrong.
 *
 * Returns a verdict rather than a boolean, because "no" and "not without a tag" are
 * different answers and the caller does different things about them:
 *
 *   standard     inside 24 hours; send normally
 *   tagged       outside, but this tag covers it
 *   blocked      outside, and no tag would make this send legitimate
 *
 * The window is measured from `last_inbound_at`, not from thread creation and not
 * from our own last reply. A thread with no inbound message at all has no window:
 * a page cannot open a conversation with someone who has never written to it.
 */
create or replace function public.message_send_allowed_raw(
  p_thread_id uuid,
  p_tag       text default null,
  p_automated boolean default true
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_thread record;
  v_tag    record;
  v_age    interval;
begin
  select * into v_thread from public.message_threads where id = p_thread_id;
  if v_thread.id is null then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'no_thread');
  end if;

  -- A page may not open a conversation. Only reply to one.
  if v_thread.last_inbound_at is null then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'never_messaged_us');
  end if;

  v_age := now() - v_thread.last_inbound_at;

  if v_age < interval '24 hours' then
    return jsonb_build_object(
      'verdict', 'standard',
      'expiresAt', v_thread.last_inbound_at + interval '24 hours',
      'hoursLeft', round(extract(epoch from (interval '24 hours' - v_age)) / 3600, 1));
  end if;

  if p_tag is null then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'window_closed',
                              'closedAt', v_thread.last_inbound_at + interval '24 hours');
  end if;

  select * into v_tag from public.message_tags where tag = p_tag;
  if v_tag.tag is null then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'unknown_tag');
  end if;

  -- HUMAN_AGENT means a person is typing. An automated send claiming it is the
  -- exact misuse that costs a page its messaging permission.
  if p_automated and not v_tag.automation_allowed then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'tag_needs_a_human');
  end if;

  if v_tag.window_hours is not null
     and v_age > make_interval(hours => v_tag.window_hours) then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'tag_window_closed');
  end if;

  return jsonb_build_object('verdict', 'tagged', 'tag', p_tag);
end;
$$;

/**
 * The same answer, for a caller who has to prove they own the thread.
 *
 * Split for the phase-11 reason, which cost a whole phase to learn: a
 * `SECURITY DEFINER` function granted to `authenticated` is **not** tenant-scoped.
 * The definer bypasses RLS, so the *function* has to check — and the definer-owned
 * callers here run with no JWT, where `is_tenant_member()` is correctly false and
 * would refuse the sends that make the feature work.
 *
 * So: an unchecked primitive granted to nobody, and a checked wrapper that is the
 * only thing granted out. Same shape as `apply_reservation` and
 * `sms_credit_balance`.
 */
create or replace function public.message_send_allowed(
  p_thread_id uuid,
  p_tag       text default null,
  p_automated boolean default true
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.message_threads where id = p_thread_id;
  if v_tenant is null then
    return jsonb_build_object('verdict', 'blocked', 'reason', 'no_thread');
  end if;
  if not public.is_tenant_member(v_tenant) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return public.message_send_allowed_raw(p_thread_id, p_tag, p_automated);
end;
$$;

-- ---------------------------------------------------------------------------
-- Inbound
-- ---------------------------------------------------------------------------
/**
 * Record a message the person sent us, and open the window.
 *
 * De-duplicates on the platform's message id *first*, for the reason that shows up
 * everywhere in this codebase and matters most here: a redelivered inbound message
 * that pushed `last_inbound_at` forward would quietly extend the 24-hour window,
 * which is a policy claim we would be making on stale evidence.
 *
 * Links the thread to a customer by PSID when we already know one. Phase 6 stores
 * `customers.fb_psid`; this is where it finally gets used.
 */
create or replace function public.record_inbound_message(
  p_account_id  uuid,
  p_psid        text,
  p_external_id text,
  p_body        text,
  p_name        text default null,
  p_sent_at     timestamptz default null,
  p_attachments jsonb default null,
  /**
   * The server's own origin, so a matched rule's `{{storeUrl}}` points at this
   * seller's shop on this deployment — never at the platform host the webhook
   * happened to arrive on.
   */
  p_root_url    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account record;
  v_thread  record;
  v_at      timestamptz := coalesce(p_sent_at, now());
  v_message uuid;
  v_new     boolean := false;
begin
  select * into v_account from public.social_accounts where id = p_account_id;
  if v_account.id is null then
    raise exception 'Account not found' using errcode = 'no_data_found';
  end if;

  insert into public.message_threads
    (tenant_id, social_account_id, platform, psid, participant_name)
  values (v_account.tenant_id, p_account_id, v_account.platform, p_psid, p_name)
  on conflict (social_account_id, psid) do update
    set participant_name = coalesce(excluded.participant_name,
                                    public.message_threads.participant_name)
  returning * into v_thread;

  -- ---- De-duplicate before the window moves -------------------------------
  insert into public.messages
    (tenant_id, thread_id, direction, external_id, body, attachments,
     source, status, sent_at)
  values (v_account.tenant_id, v_thread.id, 'in', p_external_id, p_body, p_attachments,
          'user', 'delivered', v_at)
  on conflict (thread_id, external_id) where external_id is not null do nothing
  returning id into v_message;

  if v_message is null then
    return jsonb_build_object('outcome', 'duplicate', 'threadId', v_thread.id);
  end if;
  v_new := true;

  update public.message_threads
     set last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at),
         last_message_at = greatest(coalesce(last_message_at, v_at), v_at),
         last_snippet    = left(coalesce(p_body, ''), 160),
         unread_count    = unread_count + 1,
         status          = 'open',
         -- Auto-link by PSID: phase 6 stored `customers.fb_psid` on every order
         -- placed from a live claim, and this is the join that makes an inbox
         -- message show up as a person with an order history rather than a
         -- 16-digit number.
         customer_id = coalesce(customer_id, (
           select c.id from public.customers c
           where c.tenant_id = v_account.tenant_id and c.fb_psid = p_psid
           limit 1))
   where id = v_thread.id;

  -- Matched here rather than in a second round trip. The handler would otherwise
  -- have to ask the database again for something the database already knows, and
  -- a Messenger reply that arrives late enough to notice is a reply the buyer has
  -- already given up on.
  return jsonb_build_object(
    'outcome', 'recorded', 'threadId', v_thread.id, 'messageId', v_message,
    'isNew', v_new, 'tenantId', v_account.tenant_id,
    'autoReply', public.auto_reply_for_raw(v_account.tenant_id, p_body,
                                           'message', p_root_url),
    -- Computed here, after the window has moved, so the caller can refuse to send
    -- *before* it sends. Asking afterwards is asking whether a message we have
    -- already delivered was allowed.
    'sendWindow', public.message_send_allowed_raw(v_thread.id, null, true));
end;
$$;

/**
 * Record a message we sent — and refuse it if the window says no.
 *
 * The check is *inside* the write. A caller that asked `message_send_allowed()`
 * and then sent anyway would be a caller that had checked and ignored the answer,
 * and there is no way to tell from here which it was. Refusing at the point of
 * record means the only way to log a send is to have been allowed to make it.
 *
 * `p_force_status` exists for the failure path: a send the platform rejected still
 * belongs in the thread, so the seller can see it did not go.
 */
create or replace function public.record_outbound_message(
  p_thread_id uuid,
  p_body      text,
  p_source    text default 'agent',
  p_tag       text default null,
  p_external_id text default null,
  p_status    text default 'sent',
  p_error     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thread  record;
  v_allowed jsonb;
  v_id      uuid;
begin
  select * into v_thread from public.message_threads where id = p_thread_id;
  if v_thread.id is null then
    raise exception 'Thread not found' using errcode = 'no_data_found';
  end if;

  -- `agent` means a person is typing, which is what HUMAN_AGENT is for.
  v_allowed := public.message_send_allowed_raw(p_thread_id, p_tag, p_source <> 'agent');

  if (v_allowed ->> 'verdict') = 'blocked' and p_status <> 'failed' then
    return jsonb_build_object('outcome', 'blocked', 'reason', v_allowed ->> 'reason',
                              'allowed', v_allowed);
  end if;

  insert into public.messages
    (tenant_id, thread_id, direction, external_id, body, tag, source, status, error)
  values (v_thread.tenant_id, p_thread_id, 'out', p_external_id, p_body,
          nullif(v_allowed ->> 'tag', ''), p_source, p_status, p_error)
  returning id into v_id;

  update public.message_threads
     set last_outbound_at = now(),
         last_message_at  = now(),
         last_snippet     = left(coalesce(p_body, ''), 160)
   where id = p_thread_id;

  return jsonb_build_object('outcome', 'sent', 'messageId', v_id,
                            'verdict', v_allowed ->> 'verdict');
end;
$$;

-- ---------------------------------------------------------------------------
-- Keyword matching
-- ---------------------------------------------------------------------------
/**
 * The store's own origin.
 *
 * Same rule as `sms_render_for_order`, and here for the same reason: a Facebook
 * webhook arrives on the *platform's* hostname, so composing the link from the
 * request would send every buyer to selld.ph rather than to the shop they were
 * looking at — and on a custom-domain store, to a different company's name.
 *
 * The server passes its own root URL so a dev or staging deploy links to itself
 * rather than to production, exactly as phase 11 does.
 */
create or replace function public.tenant_store_url(
  p_tenant_id uuid,
  p_root_url  text default null
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when coalesce(t.custom_domain, '') <> '' then parts.scheme || '://' || t.custom_domain
           else parts.scheme || '://' || t.slug || '.' || parts.host
         end
  from public.tenants t,
    lateral (select
      coalesce(nullif(split_part(coalesce(p_root_url, ''), '://', 1), ''), 'https') as scheme,
      coalesce(nullif(split_part(coalesce(p_root_url, ''), '://', 2), ''), 'selld.ph') as host
    ) parts
  where t.id = p_tenant_id;
$$;

/**
 * The first rule that matches, with its placeholders filled in.
 *
 * Matching happens in SQL rather than in the handler because the *rules* are rows,
 * and a matcher in the application would have to fetch them all and re-implement
 * `word` versus `contains` versus `exact` — and then do it a second time for the
 * comment path.
 *
 * `word` is the default and the one that matters: a `contains` rule for `cod` fires
 * on `codigo`, on `discod`, and on any Bisaya word with those three letters in it,
 * and a seller who wrote one rule gets a robot answering everything.
 *
 * Returns null when nothing matches, which is the ordinary case and not a failure.
 * A page that answers every message with a canned reply is worse than one that
 * answers none.
 */
create or replace function public.auto_reply_for_raw(
  p_tenant_id uuid,
  p_text      text,
  p_channel   text default 'message',
  p_root_url  text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rule   record;
  v_text   text := lower(coalesce(p_text, ''));
  v_body   text;
  v_tenant record;
  v_url    text;
begin
  if btrim(v_text) = '' then return null; end if;

  select * into v_rule
  from public.auto_replies r
  where r.tenant_id = p_tenant_id
    and r.is_active
    and (r.channel = 'both' or r.channel = p_channel)
    and case r.match_type
          -- `\m` and `\M` are Postgres's word boundaries. Without them `cod`
          -- matches inside `codigo` and the seller's one rule answers everything.
          when 'word'  then v_text ~ ('\m' || regexp_replace(lower(r.keyword),
                                        '([\\^$.|?*+()\[\]{}])', '\\\1', 'g') || '\M')
          when 'exact' then btrim(v_text) = btrim(lower(r.keyword))
          else v_text like '%' || lower(r.keyword) || '%'
        end
  order by r.priority desc, length(r.keyword) desc, r.created_at
  limit 1;

  if v_rule.id is null then return null; end if;

  select * into v_tenant from public.tenants where id = p_tenant_id;
  v_url := public.tenant_store_url(p_tenant_id, p_root_url);

  v_body := v_rule.body;
  v_body := replace(v_body, '{{storeName}}', coalesce(v_tenant.name, ''));
  v_body := replace(v_body, '{{storeUrl}}', v_url);

  return jsonb_build_object('id', v_rule.id, 'keyword', v_rule.keyword, 'body', v_body);
end;
$$;

/**
 * The same match, for the settings screen's "try it" box.
 *
 * Checked, because the raw one is not: a definer granted to `authenticated` reads
 * every tenant's rules, and a seller's canned replies are their own writing. The
 * split is the same one `message_send_allowed` uses, for the same reason.
 */
create or replace function public.auto_reply_for(
  p_tenant_id uuid,
  p_text      text,
  p_channel   text default 'message',
  p_root_url  text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return public.auto_reply_for_raw(p_tenant_id, p_text, p_channel, p_root_url);
end;
$$;

/**
 * The defaults every new store gets.
 *
 * Four rules, because those are the four questions a Filipino social seller answers
 * forty times a day. A store that connects a Page and immediately starts answering
 * "magkano" is a store that has already been paid for the integration.
 *
 * Taglish, and the keywords are the words buyers actually type — `magkano` and
 * `pila` matter far more than `price`.
 */
create or replace function public.default_auto_replies()
returns table (keyword text, match_type text, channel text, priority int, body text)
language sql
immutable
as $$
  values
    ('magkano', 'word', 'both', 10,
     'Hi! Nasa link po ang lahat ng presyo at available stocks: {{storeUrl}} 😊'),
    ('pila', 'word', 'both', 10,
     'Hi! Naa sa link ang tanan nga presyo ug stocks: {{storeUrl}} 😊'),
    ('price', 'word', 'both', 9,
     'Hi! All prices and stocks are here: {{storeUrl}} 😊'),
    ('order', 'word', 'both', 8,
     'You can order here po, may COD: {{storeUrl}} — ite-text namin ang tracking pagka-ship.'),
    ('cod', 'word', 'both', 7,
     'Opo, may COD po kami sa buong Pilipinas! Order here: {{storeUrl}}'),
    ('store', 'word', 'both', 5,
     'Here po ang store namin: {{storeUrl}}'),
    ('link', 'word', 'both', 5,
     'Here po ang link: {{storeUrl}}');
$$;

-- ---------------------------------------------------------------------------
-- The comment play
-- ---------------------------------------------------------------------------
/**
 * Record a comment on an ordinary post and decide what to do about it.
 *
 * This is the done-when: a comment arrives, and within five seconds the person has
 * a DM with the store link. The classic play is two messages — a short public reply
 * ("check your inbox po") so everyone else reading the thread sees the page is
 * responsive, and the actual answer privately.
 *
 * The comment is deduplicated on Facebook's own id *before* anything is sent,
 * because the alternative is a buyer receiving the same DM four times, and a buyer
 * who receives the same DM four times blocks the page.
 *
 * A private reply to a comment is its own Facebook affordance and does **not**
 * require an open 24-hour window — it is a reply to a public thing the person just
 * did. That is why this path exists at all, and it is exactly one reply: the window
 * rules apply to everything after.
 */
create or replace function public.record_post_comment(
  p_account_id  uuid,
  p_post_id     text,
  p_comment_id  text,
  p_psid        text,
  p_body        text,
  p_author_name text default null,
  p_parent_id   text default null,
  p_root_url    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account record;
  v_row     uuid;
  v_reply   jsonb;
  v_locale  text;
begin
  select * into v_account from public.social_accounts where id = p_account_id;
  if v_account.id is null then
    raise exception 'Account not found' using errcode = 'no_data_found';
  end if;

  insert into public.post_comments
    (tenant_id, social_account_id, post_id, comment_id, parent_id,
     psid, author_name, body)
  values (v_account.tenant_id, p_account_id, p_post_id, p_comment_id, p_parent_id,
          p_psid, p_author_name, p_body)
  on conflict (social_account_id, comment_id) do nothing
  returning id into v_row;

  if v_row is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  -- Which canned answer, if any. Nothing matching is the ordinary case: most
  -- comments are "😍" and do not want a robot.
  v_reply := public.auto_reply_for_raw(v_account.tenant_id, p_body, 'comment', p_root_url);

  if v_reply is null then
    return jsonb_build_object('outcome', 'no_rule', 'commentId', v_row,
                              'tenantId', v_account.tenant_id);
  end if;

  -- The public half of the play, in the store's own language. Short on purpose:
  -- it is for everyone *else* reading the thread, and a page that visibly answers
  -- is a page the next person is willing to ask. The real answer goes privately.
  v_locale := coalesce((select value #>> '{}' from public.tenant_settings
                        where tenant_id = v_account.tenant_id and key = 'store.locale'), 'tl');

  return jsonb_build_object(
    'outcome',   'reply',
    'commentId', v_row,
    'tenantId',  v_account.tenant_id,
    'psid',      p_psid,
    'body',      v_reply ->> 'body',
    'publicBody', case when v_locale = 'tl'
                    then 'Sent you a DM po! 💬'
                    else 'Sent you a DM! 💬' end,
    'keyword',   v_reply ->> 'keyword');
end;
$$;

/**
 * Record the DM that answered a comment.
 *
 * Deliberately not `record_outbound_message`: that function refuses anything the
 * 24-hour window does not allow, and a private reply to a comment is the one send
 * that legitimately needs no open window — the person just commented publicly, and
 * Facebook permits exactly one reply on that basis.
 *
 * The authorisation is the comment row itself. A caller has to name a real,
 * already-recorded comment, which is the same evidence Facebook is relying on, so
 * this cannot be used to open a conversation with someone who never wrote to us.
 */
create or replace function public.record_comment_dm(
  p_comment_row uuid,
  p_body        text,
  p_external_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_comment record;
  v_thread  record;
  v_id      uuid;
begin
  select * into v_comment from public.post_comments where id = p_comment_row;
  if v_comment.id is null then
    raise exception 'Comment not found' using errcode = 'no_data_found';
  end if;

  insert into public.message_threads
    (tenant_id, social_account_id, platform, psid, participant_name)
  values (v_comment.tenant_id, v_comment.social_account_id,
          (select platform from public.social_accounts
           where id = v_comment.social_account_id),
          v_comment.psid, v_comment.author_name)
  on conflict (social_account_id, psid) do update
    set participant_name = coalesce(excluded.participant_name,
                                    public.message_threads.participant_name)
  returning * into v_thread;

  insert into public.messages
    (tenant_id, thread_id, direction, external_id, body, source, status)
  values (v_comment.tenant_id, v_thread.id, 'out', p_external_id, p_body,
          'comment_reply', 'sent')
  returning id into v_id;

  -- `last_inbound_at` is untouched. A public comment is not a message, so it opens
  -- no window; treating it as one is a policy claim on evidence we do not have.
  update public.message_threads
     set last_outbound_at = now(),
         last_message_at  = now(),
         last_snippet     = left(coalesce(p_body, ''), 160)
   where id = v_thread.id;

  return v_id;
end;
$$;

/**
 * Mark what actually got sent for a comment.
 *
 * Separate from the decision so a failed Send API call is recorded as a failure
 * rather than quietly leaving the row looking like it worked — a seller reading
 * "replied" on a comment nobody answered is worse off than one reading nothing.
 */
create or replace function public.record_comment_reply(
  p_comment_row uuid,
  p_publicly    boolean,
  p_privately   boolean,
  p_error       text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.post_comments
     set replied_publicly  = replied_publicly or p_publicly,
         replied_privately = replied_privately or p_privately,
         private_reply_error = coalesce(p_error, private_reply_error)
   where id = p_comment_row;
$$;

-- ---------------------------------------------------------------------------
-- Finding a page's tenant
-- ---------------------------------------------------------------------------
/**
 * Which account a webhook belongs to.
 *
 * The only lookup here that crosses tenants — Facebook delivers a page id and
 * nothing else, because Facebook has no idea what a tenant is. Returns the ids and
 * the store's own URL, and nothing about the store beyond that.
 */
create or replace function public.social_account_for_page(
  p_platform text,
  p_page_id  text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'tenantId', a.tenant_id, 'platform', a.platform,
    'pageId', a.page_id, 'slug', t.slug, 'storeName', t.name,
    'hasToken', a.token_encrypted is not null)
  from public.social_accounts a
    join public.tenants t on t.id = a.tenant_id
  where a.platform = p_platform and a.page_id = p_page_id and a.is_active
  limit 1;
$$;

/** Which page a thread belongs to, for a reply the seller is typing right now. */
create or replace function public.social_account_for_thread(p_thread_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', a.id, 'pageId', a.page_id, 'platform', a.platform,
                            'tenantId', a.tenant_id)
  from public.message_threads t
    join public.social_accounts a on a.id = t.social_account_id
  where t.id = p_thread_id and a.is_active;
$$;

/**
 * The page token, for the server that is about to call the Send API.
 *
 * Keyed by the page rather than by our account id, because that is what the caller
 * has: a Send API call names a page, and a webhook delivers a page. Making the
 * server carry an id-to-id map it would have to keep in step is how a token gets
 * fetched for the wrong page exactly once.
 */
create or replace function public.social_page_token(
  p_platform text,
  p_page_id  text,
  p_key      text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when a.token_encrypted is null then null
    else extensions.pgp_sym_decrypt(a.token_encrypted, p_key)
  end
  from public.social_accounts a
  where a.platform = p_platform and a.page_id = p_page_id and a.is_active;
$$;

/**
 * Claim a page for a store.
 *
 * Service role only, and unchecked — the same shape as `set_courier_credentials`
 * and for the same reason. It is reached from the OAuth callback, which arrives as
 * a top-level browser navigation with no Authorization header at all, so there is
 * no caller identity here to check. The authorisation happened one step earlier and
 * is carried across the round trip by the signed `state`: `/api/social/oauth/start`
 * verifies `has_tenant_role(tenant, 'admin')` under the seller's own token before
 * minting it. Adding a check here would not make that safer; it would only make the
 * callback fail, which is exactly what it did on the first run of the phase-14
 * proof.
 *
 * Upserts on `(platform, page_id)` so reconnecting a page the seller already has is
 * the ordinary thing it looks like. A page claimed by a *different* tenant raises:
 * two stores auto-replying to the same comment would send the buyer two DMs from
 * what looks like one shop, and silently moving the page would be worse.
 */
create or replace function public.social_account_connect(
  p_tenant_id  uuid,
  p_platform   text,
  p_page_id    text,
  p_page_name  text default null,
  p_ig_user_id text default null,
  p_scopes     text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing record;
  v_id uuid;
begin
  select * into v_existing from public.social_accounts
   where platform = p_platform and page_id = p_page_id and is_active;

  if v_existing.id is not null and v_existing.tenant_id <> p_tenant_id then
    raise exception 'That page is already connected to another store'
      using errcode = 'unique_violation';
  end if;

  if v_existing.id is not null then
    update public.social_accounts
       set page_name = coalesce(p_page_name, page_name),
           ig_user_id = coalesce(p_ig_user_id, ig_user_id),
           scopes = case when array_length(p_scopes, 1) is null then scopes else p_scopes end
     where id = v_existing.id
    returning id into v_id;
    return v_id;
  end if;

  insert into public.social_accounts
    (tenant_id, platform, page_id, page_name, ig_user_id, scopes, connected_by)
  values (p_tenant_id, p_platform, p_page_id, p_page_name, p_ig_user_id, p_scopes, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

/**
 * Disconnect a page.
 *
 * The token is destroyed, not just flagged. A row that keeps a working page token
 * after the seller pressed "disconnect" is a promise broken in the one direction
 * that matters, and `is_active = false` alone would leave one sitting in the
 * database indefinitely.
 */
create or replace function public.social_account_disconnect(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.social_accounts where id = p_account_id;
  if v_tenant is null then return; end if;
  if not public.has_tenant_role(v_tenant, 'admin') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  update public.social_accounts
     set is_active = false, token_encrypted = null, token_expires_at = null,
         webhook_subscribed = false
   where id = p_account_id;
end;
$$;

/** Store one, encrypted. Service role only — the browser never holds this. */
create or replace function public.set_social_page_token(
  p_account_id uuid,
  p_token      text,
  p_key        text,
  p_expires_at timestamptz default null,
  p_subscribed boolean default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.social_accounts
     set token_encrypted = extensions.pgp_sym_encrypt(p_token, p_key),
         token_expires_at = p_expires_at,
         webhook_subscribed = coalesce(p_subscribed, webhook_subscribed)
   where id = p_account_id;
$$;

-- ---------------------------------------------------------------------------
-- The inbox
-- ---------------------------------------------------------------------------
/**
 * The thread list, with the one thing an agent has to know before they type.
 *
 * `windowHoursLeft` is on every row on purpose. A seller working through an inbox
 * needs to see which conversations are about to close *before* they choose which to
 * answer — a reply written at hour 25 is a reply that cannot be sent, and finding
 * that out after typing it is how people learn to distrust the tool.
 */
create or replace function public.inbox_threads(
  p_tenant_id uuid,
  p_status    text default 'open',
  p_limit     int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_tenant_member(p_tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'platform', t.platform, 'psid', t.psid,
      'name', coalesce(t.participant_name, 'Messenger user'),
      'snippet', t.last_snippet,
      'lastMessageAt', t.last_message_at,
      'lastInboundAt', t.last_inbound_at,
      'unread', t.unread_count,
      'status', t.status,
      'customerId', t.customer_id,
      'customerName', c.name,
      'customerOrders', c.total_orders,
      'windowHoursLeft', case
        when t.last_inbound_at is null then null
        else greatest(round(extract(epoch from
               (t.last_inbound_at + interval '24 hours' - now())) / 3600, 1), 0)
      end)
      order by t.last_message_at desc nulls last)
    from (
      select * from public.message_threads
      where tenant_id = p_tenant_id
        and (p_status = 'all' or status = p_status)
      order by last_message_at desc nulls last
      limit greatest(least(coalesce(p_limit, 50), 200), 1)
    ) t
      left join public.customers c on c.id = t.customer_id
  ), '[]'::jsonb);
end;
$$;

/** One conversation, and whether it can still be replied to. */
create or replace function public.inbox_thread(p_thread_id uuid, p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_thread record;
begin
  select * into v_thread from public.message_threads where id = p_thread_id;
  if v_thread.id is null then return null; end if;
  if not public.is_tenant_member(v_thread.tenant_id) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'id', v_thread.id,
    'platform', v_thread.platform,
    'psid', v_thread.psid,
    'name', coalesce(v_thread.participant_name, 'Messenger user'),
    'status', v_thread.status,
    'customerId', v_thread.customer_id,
    -- A person, not a page-scoped id: the agent is about to talk to them.
    'customer', (select jsonb_build_object('name', c.name, 'phone', c.phone,
                          'orders', c.total_orders)
                 from public.customers c where c.id = v_thread.customer_id),
    'sendWindow', public.message_send_allowed_raw(p_thread_id, null, false),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'direction', m.direction, 'body', m.body,
        'source', m.source, 'status', m.status, 'tag', m.tag,
        'error', m.error, 'sentAt', m.sent_at) order by m.sent_at)
      from (select * from public.messages where thread_id = p_thread_id
            order by sent_at desc
            limit greatest(least(coalesce(p_limit, 100), 500), 1)) m), '[]'::jsonb));
end;
$$;

/** Mark a thread read. The unread badge is the only reason anyone opens this. */
create or replace function public.inbox_mark_read(p_thread_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.message_threads where id = p_thread_id;
  if v_tenant is null then return; end if;
  if not public.is_tenant_member(v_tenant) then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  update public.message_threads set unread_count = 0 where id = p_thread_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.social_accounts  enable row level security;
alter table public.social_accounts  force  row level security;
alter table public.message_threads  enable row level security;
alter table public.message_threads  force  row level security;
alter table public.messages         enable row level security;
alter table public.messages         force  row level security;
alter table public.auto_replies     enable row level security;
alter table public.auto_replies     force  row level security;
alter table public.post_comments    enable row level security;
alter table public.post_comments    force  row level security;

-- No policy on `social_accounts` at all: the token lives there, and the safe view
-- is the only way in. RLS on with no policy means "nobody, by any route except a
-- definer", which is stronger than a policy somebody could widen later.

create policy "Members read threads" on public.message_threads for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read messages" on public.messages for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Members read comments" on public.post_comments for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Members read auto replies" on public.auto_replies for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy "Staff write auto replies" on public.auto_replies for insert to authenticated
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff update auto replies" on public.auto_replies for update to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'))
  with check (public.has_tenant_role(tenant_id, 'staff'));
create policy "Staff delete auto replies" on public.auto_replies for delete to authenticated
  using (public.has_tenant_role(tenant_id, 'staff'));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select on public.message_threads to authenticated;
grant select on public.messages        to authenticated;
grant select on public.post_comments   to authenticated;
grant select, insert, update, delete on public.auto_replies to authenticated;
grant select on public.social_accounts_safe to authenticated;

grant execute on function public.inbox_threads(uuid, text, int)   to authenticated;
grant execute on function public.inbox_thread(uuid, int)          to authenticated;
grant execute on function public.inbox_mark_read(uuid)            to authenticated;
grant execute on function public.message_send_allowed(uuid, text, boolean) to authenticated;
grant execute on function public.auto_reply_for(uuid, text, text, text)    to authenticated;
grant execute on function public.default_auto_replies()           to authenticated;
grant execute on function public.social_account_disconnect(uuid) to authenticated;

/**
 * Service-role only, and `from public` first — the phase-8 lesson, again.
 *
 * `social_page_token` decrypts a credential that can post as the seller and read
 * their inbox. `set_social_page_token` writes it. `record_inbound_message` moves the
 * 24-hour window, which is a compliance claim. `record_outbound_message` is the only
 * thing that may log a send. `social_account_for_page` crosses tenants.
 *
 * Each granted back to `service_role` explicitly, because `revoke ... from public`
 * removes it there too.
 */
revoke all on function public.social_page_token(text, text, text)                    from public;
revoke all on function public.set_social_page_token(uuid, text, text, timestamptz, boolean) from public;
revoke all on function public.social_account_for_page(text, text)                from public;
revoke all on function public.social_account_for_thread(uuid)                    from public;
revoke all on function public.record_inbound_message(uuid, text, text, text, text, timestamptz, jsonb, text) from public;
revoke all on function public.record_outbound_message(uuid, text, text, text, text, text, text) from public;
revoke all on function public.record_post_comment(uuid, text, text, text, text, text, text, text) from public;
revoke all on function public.record_comment_reply(uuid, boolean, boolean, text) from public;
revoke all on function public.record_comment_dm(uuid, text, text)                from public;
revoke all on function public.social_account_connect(uuid, text, text, text, text, text[]) from public;
-- The unchecked primitives. The checked wrappers above are the only way in for a
-- signed-in caller; `auto_reply_for_raw` and `tenant_store_url` are granted to
-- nobody at all, because their only callers are definer-owned functions inside the
-- database. `message_send_allowed_raw` is the exception: the server has to ask
-- before it sends, and asking afterwards is asking whether a message it has
-- already delivered was allowed.
revoke all on function public.message_send_allowed_raw(uuid, text, boolean)      from public;
revoke all on function public.auto_reply_for_raw(uuid, text, text, text)         from public;
revoke all on function public.tenant_store_url(uuid, text)                       from public;

grant execute on function public.social_page_token(text, text, text)                    to service_role;
grant execute on function public.set_social_page_token(uuid, text, text, timestamptz, boolean) to service_role;
grant execute on function public.social_account_for_page(text, text)                to service_role;
grant execute on function public.social_account_for_thread(uuid)                    to service_role;
grant execute on function public.record_inbound_message(uuid, text, text, text, text, timestamptz, jsonb, text) to service_role;
grant execute on function public.record_outbound_message(uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.record_post_comment(uuid, text, text, text, text, text, text, text) to service_role;
grant execute on function public.record_comment_reply(uuid, boolean, boolean, text) to service_role;
grant execute on function public.record_comment_dm(uuid, text, text)                to service_role;
grant execute on function public.social_account_connect(uuid, text, text, text, text, text[]) to service_role;
grant execute on function public.message_send_allowed_raw(uuid, text, boolean)      to service_role;

-- ---------------------------------------------------------------------------
-- Closing PUBLIC on the seller-facing functions
-- ---------------------------------------------------------------------------
/**
 * The phase-8 lesson, applied to phase 12 and to this phase's own screens.
 *
 * Postgres grants `EXECUTE` on every new function to **PUBLIC**, so a function
 * that is only ever granted to `authenticated` is *also* callable by `anon` — the
 * grant reads like a restriction and is not one. Phase 12's COD and returns
 * functions shipped that way, and CI's own list of things that must not be
 * anon-callable named them, which means the check was correct and red rather than
 * green: found while adding this phase's entries to the same list.
 *
 * None of them leaked anything — every one checks `is_tenant_member` or
 * `has_tenant_role` first, and a caller with no session fails that — so this
 * closes a door that was already bolted rather than one standing open. It is still
 * worth closing: the internal check is one edit away from being the only thing
 * left, and "callable by anyone on the internet" should not be the default posture
 * of a function that posts a remittance.
 *
 * The `grant ... to authenticated` lines are re-issued below each revoke because
 * `revoke ... from public` takes the privilege away from every role that held it
 * only through PUBLIC.
 */
revoke all on function public.cod_import_statement(uuid, text, jsonb, text, text, bigint) from public;
revoke all on function public.cod_remittance_summary(uuid)            from public;
revoke all on function public.cod_remittance_lines(uuid, boolean, int) from public;
revoke all on function public.cod_post_remittance(uuid)               from public;
revoke all on function public.cod_discard_remittance(uuid)            from public;
revoke all on function public.cod_reconciliation(uuid, int)           from public;
revoke all on function public.record_rts(uuid, text, boolean, bigint, text, uuid) from public;
revoke all on function public.update_rts_cost(uuid, bigint)           from public;
revoke all on function public.rts_report(uuid, int)                   from public;
revoke all on function public.buyer_risk_lookup(uuid, text)           from public;
revoke all on function public.buyer_risk_set_flag(uuid, text, boolean, boolean, text) from public;

grant execute on function public.cod_import_statement(uuid, text, jsonb, text, text, bigint) to authenticated;
grant execute on function public.cod_remittance_summary(uuid)            to authenticated;
grant execute on function public.cod_remittance_lines(uuid, boolean, int) to authenticated;
grant execute on function public.cod_post_remittance(uuid)               to authenticated;
grant execute on function public.cod_discard_remittance(uuid)            to authenticated;
grant execute on function public.cod_reconciliation(uuid, int)           to authenticated;
grant execute on function public.record_rts(uuid, text, boolean, bigint, text, uuid) to authenticated;
grant execute on function public.update_rts_cost(uuid, bigint)           to authenticated;
grant execute on function public.rts_report(uuid, int)                   to authenticated;
grant execute on function public.buyer_risk_lookup(uuid, text)           to authenticated;
grant execute on function public.buyer_risk_set_flag(uuid, text, boolean, boolean, text) to authenticated;

-- And this phase's own, for the same reason. A buyer has no inbox.
revoke all on function public.inbox_threads(uuid, text, int)   from public;
revoke all on function public.inbox_thread(uuid, int)          from public;
revoke all on function public.inbox_mark_read(uuid)            from public;
revoke all on function public.message_send_allowed(uuid, text, boolean) from public;
revoke all on function public.auto_reply_for(uuid, text, text, text)    from public;
revoke all on function public.social_account_disconnect(uuid)  from public;

grant execute on function public.inbox_threads(uuid, text, int)   to authenticated;
grant execute on function public.inbox_thread(uuid, int)          to authenticated;
grant execute on function public.inbox_mark_read(uuid)            to authenticated;
grant execute on function public.message_send_allowed(uuid, text, boolean) to authenticated;
grant execute on function public.auto_reply_for(uuid, text, text, text)    to authenticated;
grant execute on function public.social_account_disconnect(uuid)  to authenticated;

-- ---------------------------------------------------------------------------
-- Phase 13, now that there is a real page to send from
-- ---------------------------------------------------------------------------
/**
 * The live-session lookup, plus the page the session's store has connected.
 *
 * Phase 13 sent claim confirmations through the logging provider because there was
 * no token to send with. There is one now, and the only thing standing between a
 * buyer and a real "yours!" message was that the ingest path did not know which
 * page to speak as. It is added here rather than by editing phase 13's migration,
 * which is append-only once pushed.
 *
 * Null when the store has connected nothing, and the caller falls back to logging —
 * which is most stores on their first live sale.
 */
create or replace function public.live_session_for_ref(p_channel text, p_ref text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'tenantId', s.tenant_id, 'status', s.status,
    'currentCode', (select claim_code from public.live_items where id = s.current_item_id),
    'codes', coalesce((select jsonb_agg(claim_code order by sort_order)
                       from public.live_items where session_id = s.id), '[]'::jsonb),
    'pageId', (select a.page_id from public.social_accounts a
               where a.tenant_id = s.tenant_id and a.platform = 'facebook' and a.is_active
               limit 1))
  from public.live_sessions s
  where s.channel = p_channel and s.external_ref = p_ref and s.status = 'live'
  order by s.created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Seeding
-- ---------------------------------------------------------------------------
insert into public.auto_replies (tenant_id, keyword, match_type, channel, priority, body)
select t.id, d.keyword, d.match_type, d.channel, d.priority, d.body
from public.tenants t cross join public.default_auto_replies() d
on conflict do nothing;


-- New tenants get them too. The backfill above only covers stores that already
-- exist — the phase-8 mistake where `payments.methods` was backfilled and not
-- seeded, so every store created afterwards had the feature switched off.
create or replace function public.seed_tenant_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.storefront_themes (tenant_id)
  values (new.id)
  on conflict (tenant_id) do nothing;

  insert into public.tenant_settings (tenant_id, key, value) values
    (new.id, 'onboarding.step', '1'::jsonb),
    (new.id, 'onboarding.completed_at', 'null'::jsonb),
    (new.id, 'payments.cod_enabled', 'true'::jsonb),
    (new.id, 'payments.cod_fee_centavos', '0'::jsonb),
    (new.id, 'payments.cod_fee_bps', '0'::jsonb),
    (new.id, 'payments.online_enabled', 'false'::jsonb),
    (new.id, 'payments.methods', '["gcash","maya","grabpay","qrph","card"]'::jsonb),
    (new.id, 'orders.number_prefix', '""'::jsonb),
    (new.id, 'orders.auto_confirm', 'false'::jsonb),
    (new.id, 'catalog.presets', '[]'::jsonb),
    (new.id, 'shipping.flat_centavos', '8000'::jsonb),
    (new.id, 'risk.contribute_signal', 'false'::jsonb),
    (new.id, 'risk.use_shared_signal', 'false'::jsonb)
  on conflict (tenant_id, key) do nothing;

  insert into public.sms_templates (tenant_id, event, locale, body)
  select new.id, d.event, d.locale, d.body from public.default_sms_templates() d
  on conflict (tenant_id, event, locale) do nothing;

  insert into public.sms_credit_entries (tenant_id, delta, balance_after, reason, note)
  values (new.id, 100, 100, 'trial', 'Welcome credits');

  -- Phase 14. A store that connects a Page starts answering "magkano" the same
  -- afternoon, which is the whole reason to connect one.
  insert into public.auto_replies (tenant_id, keyword, match_type, channel, priority, body)
  select new.id, d.keyword, d.match_type, d.channel, d.priority, d.body
  from public.default_auto_replies() d;

  insert into public.order_counters (tenant_id) values (new.id)
  on conflict (tenant_id) do nothing;

  return new;
end;
$$;

comment on table public.social_accounts is
  'A connected Page or IG account. The token is encrypted and has no read grant.';
comment on table public.message_threads is
  'One conversation. last_inbound_at is what the 24-hour messaging window counts from.';
comment on function public.message_send_allowed(uuid, text, boolean) is
  'The single decision point for whether a message may be sent, and under what tag.';
