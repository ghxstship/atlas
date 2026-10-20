-- 1382_subprocessor_notices.sql
-- A82 compliance flows (RRR-127), finding A65-014 (Section 14.4 item 5, legal/subprocessors.md section 1). The Subprocessor
-- List promises 30 days' notice of a new subprocessor and a subscription to change notices, which did not exist. This
-- migration adds:
--   * the public subscription with double opt-in: api_public.subscribe_subprocessor_notices records a Pending address
--     and queues a confirmation email; only api_public.confirm_subprocessor_notices, with the token from that email,
--     makes it Confirmed. api_public.unsubscribe_subprocessor_notices ends it with any unsubscribe token it was sent.
--     Tokens are stored as SHA-256 hashes. The subscribe call answers the same whatever the address's state, so it
--     reveals nothing about who subscribed; it is limited to 10 calls per client address an hour and 3 per address a
--     day, and every token call refuses a read-only (GET) request first (A69-001);
--   * Owners and Admins of a customer org are subscribed by default, as the list says, and opt out or back in through
--     app.set_subprocessor_notice_subscription (Settings, Notifications);
--   * app.queue_subprocessor_notice, for the platform team (service role): it refuses a change taking effect sooner than
--     30 days ahead, records the notice and queues one email per recipient, each Confirmed subscriber with an
--     unsubscribe link of their own;
--   * private.platform_emails, the outbox of emails sent by the platform rather than an org, worked by the
--     subprocessor-notices Edge Function through app.claim_platform_emails and app.finish_platform_email. Tokens
--     travel in a row's args only until the email is sent; then the args are cleared.

-- Outbox ------------------------------------------------------------------------------------------------------------

create table private.platform_emails (
  id uuid primary key default private.uuid_v7(),
  template text not null,
  to_email text not null,
  locale text not null default 'en-US',
  args jsonb,
  send_state text not null default 'Queued',
  attempts smallint not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  constraint platform_emails_template check (template in ('subprocessor_confirm', 'subprocessor_notice')),
  constraint platform_emails_to check (to_email = lower(to_email) and to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(to_email) <= 320),
  constraint platform_emails_locale check (locale in ('en-US', 'es-US')),
  constraint platform_emails_state check (send_state in ('Queued', 'Sending', 'Sent', 'Failed')),
  constraint platform_emails_attempts check (attempts between 0 and 5),
  constraint platform_emails_error_length check (error is null or char_length(error) <= 1000)
);

create index platform_emails_due_idx on private.platform_emails (send_state, created_at);

comment on table private.platform_emails is 'Emails the platform sends in its own name rather than an org''s (Section 14.4): subprocessor subscription confirmations and change notices. Worked by the subprocessor-notices Edge Function; a row''s args, which may hold a token, are cleared once the email is sent.';
comment on column private.platform_emails.id is 'Email id (UUID v7).';
comment on column private.platform_emails.template is 'Template: subprocessor_confirm or subprocessor_notice (packages/email).';
comment on column private.platform_emails.to_email is 'Recipient address, lowercased.';
comment on column private.platform_emails.locale is 'Language of the email: en-US or es-US.';
comment on column private.platform_emails.args is 'Template arguments, such as a confirmation or unsubscribe token; cleared once sent.';
comment on column private.platform_emails.send_state is 'Queued, Sending, Sent or Failed (after 5 attempts).';
comment on column private.platform_emails.attempts is 'Send attempts so far.';
comment on column private.platform_emails.claimed_at is 'When a worker last claimed the email.';
comment on column private.platform_emails.sent_at is 'When the email was sent.';
comment on column private.platform_emails.provider_message_id is 'Message id the email provider returned.';
comment on column private.platform_emails.error is 'Why the last attempt failed.';
comment on column private.platform_emails.created_at is 'When the email was queued.';

alter table private.platform_emails enable row level security;
revoke all on private.platform_emails from public, anon, authenticated;
grant select on private.platform_emails to service_role;

-- Subscriptions -------------------------------------------------------------------------------------------------------

create table private.subprocessor_subscriptions (
  id uuid primary key default private.uuid_v7(),
  email text not null,
  locale text not null default 'en-US',
  subscription_state text not null default 'Pending',
  confirm_token_hash bytea,
  confirm_expires_at timestamptz,
  requested_at timestamptz not null default now(),
  requested_ip inet,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  constraint subprocessor_subscriptions_email_key unique (email),
  constraint subprocessor_subscriptions_email check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint subprocessor_subscriptions_locale check (locale in ('en-US', 'es-US')),
  constraint subprocessor_subscriptions_state check (subscription_state in ('Pending', 'Confirmed', 'Unsubscribed')),
  constraint subprocessor_subscriptions_confirm check ((subscription_state = 'Pending') = (confirm_token_hash is not null))
);

create unique index subprocessor_subscriptions_confirm_key on private.subprocessor_subscriptions (confirm_token_hash);

comment on table private.subprocessor_subscriptions is 'Addresses subscribed to Subprocessor List change notices (legal/subprocessors.md section 1), confirmed by double opt-in: Pending until the person opens the confirmation link, then Confirmed until they unsubscribe.';
comment on column private.subprocessor_subscriptions.id is 'Subscription id (UUID v7).';
comment on column private.subprocessor_subscriptions.email is 'Subscribed address, lowercased.';
comment on column private.subprocessor_subscriptions.locale is 'Language of the notices: en-US or es-US.';
comment on column private.subprocessor_subscriptions.subscription_state is 'Pending (confirmation sent), Confirmed or Unsubscribed.';
comment on column private.subprocessor_subscriptions.confirm_token_hash is 'SHA-256 of the confirmation token, while Pending.';
comment on column private.subprocessor_subscriptions.confirm_expires_at is 'When the confirmation link stops working: 7 days after it was sent.';
comment on column private.subprocessor_subscriptions.requested_at is 'When the subscription was last requested.';
comment on column private.subprocessor_subscriptions.requested_ip is 'Client address of the last request, as evidence of the opt-in.';
comment on column private.subprocessor_subscriptions.confirmed_at is 'When the address was confirmed.';
comment on column private.subprocessor_subscriptions.unsubscribed_at is 'When the address unsubscribed.';

alter table private.subprocessor_subscriptions enable row level security;
revoke all on private.subprocessor_subscriptions from public, anon, authenticated;
grant select on private.subprocessor_subscriptions to service_role;

create table private.subprocessor_unsubscribe_tokens (
  token_hash bytea primary key,
  subscription_id uuid not null references private.subprocessor_subscriptions (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint subprocessor_unsubscribe_tokens_length check (octet_length(token_hash) = 32)
);

create index subprocessor_unsubscribe_tokens_subscription_idx on private.subprocessor_unsubscribe_tokens (subscription_id);

comment on table private.subprocessor_unsubscribe_tokens is 'One unsubscribe token per email sent to a subscriber, stored as its SHA-256; any of them ends the subscription.';
comment on column private.subprocessor_unsubscribe_tokens.token_hash is 'SHA-256 of the unsubscribe token.';
comment on column private.subprocessor_unsubscribe_tokens.subscription_id is 'Subscription the token ends.';
comment on column private.subprocessor_unsubscribe_tokens.created_at is 'When the token was issued.';

alter table private.subprocessor_unsubscribe_tokens enable row level security;
revoke all on private.subprocessor_unsubscribe_tokens from public, anon, authenticated;
grant select on private.subprocessor_unsubscribe_tokens to service_role;

create table private.subprocessor_notice_optouts (
  person_id uuid primary key references app.people (id) on delete cascade,
  opted_out_at timestamptz not null default now()
);

comment on table private.subprocessor_notice_optouts is 'Owners and Admins of customer orgs who opted out of the change notices they receive by default (legal/subprocessors.md section 1).';
comment on column private.subprocessor_notice_optouts.person_id is 'Person who opted out.';
comment on column private.subprocessor_notice_optouts.opted_out_at is 'When they opted out.';

alter table private.subprocessor_notice_optouts enable row level security;
revoke all on private.subprocessor_notice_optouts from public, anon, authenticated;
grant select on private.subprocessor_notice_optouts to service_role;

create table private.subprocessor_notices (
  id uuid primary key default private.uuid_v7(),
  list_version text not null,
  summary text not null,
  effective_on date not null,
  queued_at timestamptz not null default now(),
  recipient_count integer not null default 0,
  constraint subprocessor_notices_version check (list_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.]+)?$'),
  constraint subprocessor_notices_summary check (char_length(btrim(summary)) between 1 and 2000),
  constraint subprocessor_notices_recipients check (recipient_count >= 0)
);

comment on table private.subprocessor_notices is 'Each Subprocessor List change notice sent (legal/subprocessors.md sections 1 and 5): the list version, what changes, when it takes effect (at least 30 days after the notice) and how many recipients it was queued for.';
comment on column private.subprocessor_notices.id is 'Notice id (UUID v7).';
comment on column private.subprocessor_notices.list_version is 'Subprocessor List version the notice announces.';
comment on column private.subprocessor_notices.summary is 'What changes: the subprocessor, what it processes, where and why.';
comment on column private.subprocessor_notices.effective_on is 'First day the change applies; at least 30 days after the notice.';
comment on column private.subprocessor_notices.queued_at is 'When the notice was queued.';
comment on column private.subprocessor_notices.recipient_count is 'Emails queued for the notice.';

alter table private.subprocessor_notices enable row level security;
revoke all on private.subprocessor_notices from public, anon, authenticated;
grant select on private.subprocessor_notices to service_role;

-- Public subscription calls --------------------------------------------------------------------------------------------

create or replace function private.valid_notice_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when lower(btrim(coalesce(p_email, ''))) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and char_length(btrim(p_email)) <= 320 then lower(btrim(p_email)) end;
$$;

comment on function private.valid_notice_email(text) is 'The address lowercased and trimmed, or NULL when it is not an email address.';
revoke all on function private.valid_notice_email(text) from public, anon, authenticated;

create or replace function api_public.subscribe_subprocessor_notices(p_email text, p_locale text default 'en-US')
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_email text;
  v_locale text := case when p_locale = 'es-US' then 'es-US' else 'en-US' end;
  v_token text;
  v_state text;
begin
  perform private.require_read_write();
  v_client := coalesce(host(private.request_ip()), 'unknown');
  v_email := private.valid_notice_email(p_email);
  if v_email is null then
    return false;
  end if;
  if private.rate_limit_exceeded('subprocessor.subscribe', v_client, 10, interval '1 hour')
     or private.rate_limit_exceeded('subprocessor.subscribe.email', v_email, 3, interval '1 day') then
    return true;
  end if;
  perform private.note_rate_event('subprocessor.subscribe', v_client);
  perform private.note_rate_event('subprocessor.subscribe.email', v_email);
  select s.subscription_state into v_state from private.subprocessor_subscriptions s where s.email = v_email for update;
  -- A Confirmed address needs nothing; the answer is the same either way.
  if v_state = 'Confirmed' then
    return true;
  end if;
  v_token := 'xspn_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.subprocessor_subscriptions (email, locale, subscription_state, confirm_token_hash, confirm_expires_at,
    requested_at, requested_ip)
  values (v_email, v_locale, 'Pending', extensions.digest(v_token, 'sha256'), now() + interval '7 days', now(), private.request_ip())
  on conflict (email) do update set locale = excluded.locale, subscription_state = 'Pending',
    confirm_token_hash = excluded.confirm_token_hash, confirm_expires_at = excluded.confirm_expires_at,
    requested_at = excluded.requested_at, requested_ip = excluded.requested_ip, unsubscribed_at = null;
  insert into private.platform_emails (template, to_email, locale, args)
  values ('subprocessor_confirm', v_email, v_locale, jsonb_build_object('confirm_token', v_token));
  return true;
end;
$$;

comment on function api_public.subscribe_subprocessor_notices(text, text) is 'Subscribes an address to Subprocessor List change notices with double opt-in (legal/subprocessors.md section 1): records it Pending and queues a confirmation email whose link expires in 7 days. Answers true for any address, so it reveals nothing about who subscribed (false only for something that is not an address); 10 calls per client address an hour and 3 per address a day. Refuses a read-only (GET) call first.';
revoke all on function api_public.subscribe_subprocessor_notices(text, text) from public;
grant execute on function api_public.subscribe_subprocessor_notices(text, text) to anon, authenticated, service_role;

create or replace function api_public.confirm_subprocessor_notices(p_token text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_id uuid;
begin
  perform private.require_read_write();
  v_client := coalesce(host(private.request_ip()), 'unknown');
  if private.rate_limit_exceeded('subprocessor.token.failure', v_client, 20, interval '10 minutes') then
    return false;
  end if;
  select s.id into v_id from private.subprocessor_subscriptions s
  where s.confirm_token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
    and s.subscription_state = 'Pending' and s.confirm_expires_at > now()
  for update;
  if v_id is null then
    perform private.note_rate_event('subprocessor.token.failure', v_client);
    return false;
  end if;
  update private.subprocessor_subscriptions set subscription_state = 'Confirmed', confirm_token_hash = null,
    confirm_expires_at = null, confirmed_at = now()
  where id = v_id;
  return true;
end;
$$;

comment on function api_public.confirm_subprocessor_notices(text) is 'The second step of the double opt-in: the token from the confirmation email makes the subscription Confirmed, once, within 7 days. Refuses a read-only (GET) call first, so a mail scanner that only fetches the link confirms nothing; 20 failures per client address in 10 minutes refuse the address.';
revoke all on function api_public.confirm_subprocessor_notices(text) from public;
grant execute on function api_public.confirm_subprocessor_notices(text) to anon, authenticated, service_role;

create or replace function api_public.unsubscribe_subprocessor_notices(p_token text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text;
  v_id uuid;
begin
  perform private.require_read_write();
  v_client := coalesce(host(private.request_ip()), 'unknown');
  if private.rate_limit_exceeded('subprocessor.token.failure', v_client, 20, interval '10 minutes') then
    return false;
  end if;
  select t.subscription_id into v_id from private.subprocessor_unsubscribe_tokens t
  where t.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256');
  if v_id is null then
    perform private.note_rate_event('subprocessor.token.failure', v_client);
    return false;
  end if;
  update private.subprocessor_subscriptions set subscription_state = 'Unsubscribed', confirm_token_hash = null,
    confirm_expires_at = null, unsubscribed_at = coalesce(unsubscribed_at, now())
  where id = v_id;
  return true;
end;
$$;

comment on function api_public.unsubscribe_subprocessor_notices(text) is 'Ends a subscription with any unsubscribe token a notice carried. Idempotent. Refuses a read-only (GET) call first.';
revoke all on function api_public.unsubscribe_subprocessor_notices(text) from public;
grant execute on function api_public.unsubscribe_subprocessor_notices(text) to anon, authenticated, service_role;

-- Members: Owners and Admins are subscribed by default -----------------------------------------------------------------

create or replace function private.receives_subprocessor_notices_by_default(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.org_id is null and r.code in ('owner', 'admin')
    join app.organizations o on o.id = m.org_id and o.deleted_at is null
    where m.person_id = p_person_id and m.deleted_at is null and m.valid_from <= now()
      and (m.valid_to is null or m.valid_to > now()));
$$;

comment on function private.receives_subprocessor_notices_by_default(uuid) is 'True when the person is an Owner or Admin of an org, who receive Subprocessor List change notices by default.';
revoke all on function private.receives_subprocessor_notices_by_default(uuid) from public, anon, authenticated;

create or replace function app.subprocessor_notice_subscription()
returns table (eligible boolean, subscribed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select private.receives_subprocessor_notices_by_default(private.current_person_id()),
    private.receives_subprocessor_notices_by_default(private.current_person_id())
      and not exists (select 1 from private.subprocessor_notice_optouts o where o.person_id = private.current_person_id());
$$;

comment on function app.subprocessor_notice_subscription() is 'For the signed-in person: whether they receive Subprocessor List change notices by default (an Owner or Admin of an org) and whether they still do (not opted out).';
revoke all on function app.subprocessor_notice_subscription() from public, anon;
grant execute on function app.subprocessor_notice_subscription() to authenticated, service_role;

create or replace function app.set_subprocessor_notice_subscription(p_subscribed boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if coalesce(p_subscribed, false) then
    delete from private.subprocessor_notice_optouts where person_id = v_person;
  else
    insert into private.subprocessor_notice_optouts (person_id) values (v_person) on conflict (person_id) do nothing;
  end if;
  return coalesce(p_subscribed, false);
end;
$$;

comment on function app.set_subprocessor_notice_subscription(boolean) is 'Opts the signed-in person out of, or back into, the Subprocessor List change notices Owners and Admins receive by default (Settings, Notifications).';
revoke all on function app.set_subprocessor_notice_subscription(boolean) from public, anon;
grant execute on function app.set_subprocessor_notice_subscription(boolean) to authenticated, service_role;

-- Sending a notice (platform team) ---------------------------------------------------------------------------------------

create or replace function app.queue_subprocessor_notice(p_list_version text, p_summary text, p_effective_on date)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_notice uuid;
  v_count integer := 0;
  v_members integer;
  v_sub record;
  v_token text;
begin
  if p_effective_on is null or p_effective_on < current_date + 30 then
    perform private.refuse('subprocessor_notice_period', 'A subprocessor change takes effect at least 30 days after its notice (legal/subprocessors.md section 1).');
  end if;
  insert into private.subprocessor_notices (list_version, summary, effective_on)
  values (p_list_version, btrim(p_summary), p_effective_on)
  returning id into v_notice;

  for v_sub in select s.id, s.email, s.locale from private.subprocessor_subscriptions s where s.subscription_state = 'Confirmed' loop
    v_token := 'xspu_' || encode(extensions.gen_random_bytes(32), 'hex');
    insert into private.subprocessor_unsubscribe_tokens (token_hash, subscription_id)
    values (extensions.digest(v_token, 'sha256'), v_sub.id);
    insert into private.platform_emails (template, to_email, locale, args)
    values ('subprocessor_notice', v_sub.email, v_sub.locale, jsonb_build_object('list_version', p_list_version,
      'summary', btrim(p_summary), 'effective_on', p_effective_on, 'unsubscribe_token', v_token));
    v_count := v_count + 1;
  end loop;

  insert into private.platform_emails (template, to_email, locale, args)
  select 'subprocessor_notice', lower(u.email), 'en-US', jsonb_build_object('list_version', p_list_version,
    'summary', btrim(p_summary), 'effective_on', p_effective_on, 'member', true)
  from app.people p
  join auth.users u on u.id = p.user_id
  where p.deleted_at is null and u.email is not null and private.valid_notice_email(u.email) is not null
    and private.receives_subprocessor_notices_by_default(p.id)
    and not exists (select 1 from private.subprocessor_notice_optouts o where o.person_id = p.id)
    and not exists (select 1 from private.subprocessor_subscriptions s
                    where s.email = lower(u.email) and s.subscription_state = 'Confirmed');
  get diagnostics v_members = row_count;
  v_count := v_count + v_members;
  update private.subprocessor_notices set recipient_count = v_count where id = v_notice;
  return v_count;
end;
$$;

comment on function app.queue_subprocessor_notice(text, text, date) is 'Service role only (the platform team): records a Subprocessor List change notice and queues one email per recipient: each Confirmed subscriber, with an unsubscribe link of their own, and each Owner and Admin who has not opted out. Refuses a change that takes effect less than 30 days ahead. Answers the emails queued.';
revoke all on function app.queue_subprocessor_notice(text, text, date) from public, anon, authenticated;
grant execute on function app.queue_subprocessor_notice(text, text, date) to service_role;

-- Worker ----------------------------------------------------------------------------------------------------------------

create or replace function app.claim_platform_emails(p_limit integer default 25)
returns table (id uuid, template text, to_email text, locale text, args jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select e.id from private.platform_emails e
    where e.send_state = 'Queued' or (e.send_state = 'Sending' and e.claimed_at < now() - interval '10 minutes')
    order by e.created_at
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  )
  update private.platform_emails e set send_state = 'Sending', claimed_at = now(), attempts = least(e.attempts + 1, 5)
  from due where e.id = due.id
  returning e.id, e.template, e.to_email, e.locale, e.args;
end;
$$;

comment on function app.claim_platform_emails(integer) is 'Service role only (the subprocessor-notices Edge Function): claims up to p_limit queued platform emails, and any left Sending for 10 minutes, oldest first.';
revoke all on function app.claim_platform_emails(integer) from public, anon, authenticated;
grant execute on function app.claim_platform_emails(integer) to service_role;

create or replace function app.finish_platform_email(p_id uuid, p_sent boolean, p_provider_message_id text default null, p_error text default null)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  update private.platform_emails e set
    send_state = case when p_sent then 'Sent' when e.attempts >= 5 then 'Failed' else 'Queued' end,
    sent_at = case when p_sent then now() end,
    provider_message_id = case when p_sent then left(p_provider_message_id, 200) end,
    error = case when p_sent then null else left(coalesce(p_error, 'unknown'), 1000) end,
    args = case when p_sent then null else e.args end
  where e.id = p_id
  returning e.send_state into v_state;
  return v_state;
end;
$$;

comment on function app.finish_platform_email(uuid, boolean, text, text) is 'Service role only: records a send attempt. A sent email keeps no args (its tokens are gone); a failed one goes back to Queued until its fifth attempt, then Failed. Answers the new state.';
revoke all on function app.finish_platform_email(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function app.finish_platform_email(uuid, boolean, text, text) to service_role;
