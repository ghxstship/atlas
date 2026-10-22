-- pgTAP: migration 1382, finding A65-014 (RRR-127). Subprocessor change notices: a double opt-in subscription whose calls
-- reveal nothing and refuse GET, Owners and Admins subscribed by default with an opt-out, the 30-day notice rule, one
-- email per recipient with its own unsubscribe link, and the outbox that forgets tokens once sent.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

create temporary table k (key text primary key, val text);
grant select, insert, update on k to public;

-- Runs a public call as anon from one address.
create function pg_temp.anon_call(p_sql text) returns text
language plpgsql as $$
declare
  v_out text;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', '{"x-forwarded-for": "198.51.100.60"}', true);
  execute p_sql into v_out;
  perform pg_temp.as_platform();
  return v_out;
end $$;

-- Subscribing ---------------------------------------------------------------------------------------------------------
select is(pg_temp.anon_call($$select api_public.subscribe_subprocessor_notices('Dana@Example.test', 'es-US')::text$$), 'true',
  'anyone can subscribe');
select results_eq($$select email, locale, subscription_state from private.subprocessor_subscriptions where email = 'dana@example.test'$$,
  $$values ('dana@example.test'::text, 'es-US'::text, 'Pending'::text)$$, 'the address waits for its confirmation, lowercased');
select is((select count(*)::int from private.platform_emails where template = 'subprocessor_confirm' and to_email = 'dana@example.test'), 1,
  'a confirmation email is queued');
insert into k select 'confirm', args ->> 'confirm_token' from private.platform_emails where to_email = 'dana@example.test';
select ok((select confirm_token_hash = extensions.digest((select val from k where key = 'confirm'), 'sha256')
  from private.subprocessor_subscriptions where email = 'dana@example.test'), 'only the hash of the confirmation token is stored');
select is(pg_temp.anon_call($$select api_public.subscribe_subprocessor_notices('not an address')::text$$), 'false',
  'something that is not an address is refused');

-- GET is refused before anything happens (A69-001)
create function pg_temp.read_only(p_sql text) returns text
language plpgsql as $$
begin
  perform pg_temp.as_anon();
  begin
    perform set_config('transaction_read_only', 'on', true);
    execute p_sql;
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception
    when sqlstate 'ZZ001' then return 'none';
    when others then return sqlstate;
  end;
end $$;
select is(pg_temp.read_only(format('select api_public.confirm_subprocessor_notices(%L)', (select val from k where key = 'confirm'))), '25006',
  'confirming through GET (a mail scanner fetching the link) is refused');
select pg_temp.as_platform();
select is((select subscription_state from private.subprocessor_subscriptions where email = 'dana@example.test'), 'Pending',
  'and confirms nothing');

select is(pg_temp.anon_call($$select api_public.confirm_subprocessor_notices('xspn_wrong')::text$$), 'false', 'a wrong token confirms nothing');
select is(pg_temp.anon_call(format('select api_public.confirm_subprocessor_notices(%L)::text', (select val from k where key = 'confirm'))), 'true',
  'the emailed token confirms the subscription');
select is((select subscription_state from private.subprocessor_subscriptions where email = 'dana@example.test'), 'Confirmed',
  'the address is Confirmed');
select is(pg_temp.anon_call(format('select api_public.confirm_subprocessor_notices(%L)::text', (select val from k where key = 'confirm'))), 'false',
  'a confirmation token works once');
select is(pg_temp.anon_call($$select api_public.subscribe_subprocessor_notices('dana@example.test')::text$$), 'true',
  'subscribing a Confirmed address answers the same as any other');
select is((select count(*)::int from private.platform_emails where to_email = 'dana@example.test'), 1,
  'and sends nothing more');

-- Owners and Admins are subscribed by default ---------------------------------------------------------------------------
select pg_temp.as_user('bob');
select results_eq($$select eligible, subscribed from app.subprocessor_notice_subscription()$$, $$values (true, true)$$,
  'an Admin receives the notices by default');
select pg_temp.as_user('dave');
select results_eq($$select eligible, subscribed from app.subprocessor_notice_subscription()$$, $$values (false, false)$$,
  'a Member does not');
select pg_temp.as_user('xavier');
select is(app.set_subprocessor_notice_subscription(false), false, 'an Owner may opt out');
select pg_temp.as_user('alice');
select throws_ok($$select app.queue_subprocessor_notice('1.1.0', 'Adds Example Mail Inc. for inbound email.', current_date + 45)$$,
  '42501', null, 'only the platform team queues a notice');

-- Sending a notice ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('role', 'service_role', true);
select throws_ok($$select app.queue_subprocessor_notice('1.1.0', 'Adds Example Mail Inc. for inbound email.', current_date + 10)$$,
  'XR001', null, 'a change takes effect at least 30 days after its notice');
insert into k values ('queued', app.queue_subprocessor_notice('1.1.0', 'Adds Example Mail Inc. for inbound email.', current_date + 45)::text);
select pg_temp.as_platform();
select is((select count(*)::int from private.platform_emails where template = 'subprocessor_notice' and to_email = 'dana@example.test'
  and args ? 'unsubscribe_token'), 1, 'a Confirmed subscriber gets the notice with an unsubscribe link of their own');
select is((select count(*)::int from private.platform_emails where template = 'subprocessor_notice'
  and to_email in ('alice@northwind.test', 'bob@northwind.test', 'xavier@harborlights.test')),
  2, 'Owners and Admins get it too, except the one who opted out');

insert into k select 'unsubscribe', args ->> 'unsubscribe_token' from private.platform_emails
where template = 'subprocessor_notice' and to_email = 'dana@example.test';

-- The worker: the outbox forgets the token once the email is sent
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('role', 'service_role', true);
insert into k select 'email', e.id::text from app.claim_platform_emails(100) e where e.to_email = 'dana@example.test' and e.template = 'subprocessor_notice';
select is(app.finish_platform_email((select val from k where key = 'email')::uuid, true, 'msg-1'), 'Sent', 'a sent email is recorded');
select pg_temp.as_platform();
select is((select args from private.platform_emails where id = (select val from k where key = 'email')::uuid), null,
  'a sent email keeps no token');

-- Unsubscribing with the link the notice carried
select is(pg_temp.anon_call(format('select api_public.unsubscribe_subprocessor_notices(%L)::text', (select val from k where key = 'unsubscribe'))),
  'true', 'the notice''s unsubscribe link ends the subscription');
select is((select subscription_state from private.subprocessor_subscriptions where email = 'dana@example.test'), 'Unsubscribed',
  'the address is Unsubscribed');

select * from finish();
rollback;
