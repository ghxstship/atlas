-- pgTAP: migration 2975 (B8, G-71), bulk guest emails. The queue's authority, batch, message and daily org limits;
-- every requested guest gets a row (Queued, Suppressed by the org's suppression list, or Skipped with the reason);
-- the summary counts them; the worker claims each Queued row once, checks it again and finishes it idempotently;
-- unsubscribe refuses a read-only call, suppresses the address once for that org only and answers an unknown token the
-- same way; staff never write the tables directly; readers need advancing.packet.read; the addresses are Confidential.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name, entry_state, guest_email) values (pg_temp.id('prj_a'), 'Sasha Bell', 'Approved', 'sasha@example.test') returning id) insert into world select 'g_pass', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name, guest_email) values (pg_temp.id('prj_a'), 'Rowan Hale', 'rowan@example.test') returning id) insert into world select 'g_req', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Jo Park') returning id) insert into world select 'g_none', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name, entry_state, guest_email) values (pg_temp.id('prj_a'), 'Lee Park', 'Approved', 'lee@example.test') returning id) insert into world select 'g_supp', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name, guest_email) values (pg_temp.id('prj_a'), 'Max Ray', 'max@example.test') returning id) insert into world select 'g_gone', id from x;
update app.guest_list_entries set deleted_at = now() where id = pg_temp.id('g_gone');
select pg_temp.as_platform();
insert into app.suppression_list (org_id, channel, address, reason) values (pg_temp.id('org_a'), 'Email', 'lee@example.test', 'Hard Bounce');
insert into app.suppression_list (org_id, channel, address, reason, category_code) values (pg_temp.id('org_a'), 'Email', 'rowan@example.test', 'Unsubscribe', 'mentions');

-- Queueing -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), array[(select id from world where key = 'g_pass')], 'Invitation')$$,
  '42501', null, 'a Viewer without advancing.rider.write cannot email guests');
select pg_temp.as_user('carol');
select throws_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), '{}'::uuid[], 'Invitation')$$,
  'XR001', 'guest_email_batch: Email 1 to 500 guests at a time.', 'an empty selection is refused');
select throws_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), array(select gen_random_uuid() from generate_series(1, 501)), 'Invitation')$$,
  'XR001', 'guest_email_batch: Email 1 to 500 guests at a time.', 'more than 500 is refused');
select throws_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), array[(select id from world where key = 'g_pass')], 'Message', 'Doors at 7')$$,
  'XR001', 'guest_email_message: A message needs a subject of up to 150 characters and a text of up to 5,000.', 'a Message needs a body');
select throws_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), array[(select id from world where key = 'g_pass')], 'Message', null, 'Doors open at 7.')$$,
  'XR001', 'guest_email_message: A message needs a subject of up to 150 characters and a text of up to 5,000.', 'and a subject');

insert into world values ('send_pass', app.queue_guest_emails(pg_temp.id('prj_a'),
  array[pg_temp.id('g_pass'), pg_temp.id('g_req'), pg_temp.id('g_none'), pg_temp.id('g_supp'), pg_temp.id('g_gone')], 'Pass', null, null, 'es-US'));
select is((select row(queued, suppressed, skipped, skipped_no_email, skipped_not_live, skipped_no_pass)::text from app.guest_email_send_summary(pg_temp.id('send_pass'))),
  '(1,1,3,1,1,1)', 'a Pass send queues the approved guest, suppresses the bounced address and skips no email, not live and no pass');
select is((select send_state::text from app.guest_emails where guest_list_entry_id = pg_temp.id('g_supp') and guest_email_send_id = pg_temp.id('send_pass')),
  'Suppressed', 'a hard bounce suppresses the address');
insert into world values ('send_inv', app.queue_guest_emails(pg_temp.id('prj_a'), array[pg_temp.id('g_req')], 'Invitation'));
select is((select send_state::text from app.guest_emails where guest_email_send_id = pg_temp.id('send_inv')), 'Queued',
  'an unsubscribe from one category does not stop guest email');
select is((select locale from app.guest_email_sends where id = pg_temp.id('send_pass')), 'es-US', 'the send keeps its language');

-- Direct writes and reads -------------------------------------------------------------------------------------------------------
select throws_ok($$insert into app.guest_email_sends (project_id, email_kind) values ((select id from world where key = 'prj_a'), 'Invitation')$$,
  '42501', null, 'staff never insert a send directly');
select throws_ok($$update app.guest_emails set send_state = 'Sent' where guest_email_send_id = (select id from world where key = 'send_inv')$$,
  '42501', null, 'nor update a recipient row');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.guest_emails where guest_email_send_id = pg_temp.id('send_pass')), 5, 'a project member who reads advance packets sees the rows');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.guest_emails), 0, 'another org sees none');
select throws_ok($$select * from app.guest_email_send_summary((select id from world where key = 'send_pass'))$$, '42501', null, 'nor the summary');
select pg_temp.as_platform();
select is((select classification::text from private.column_classifications where table_name = 'app.guest_emails' and column_name = 'to_email'),
  'Confidential', 'the address is Confidential');

-- The daily org limit ------------------------------------------------------------------------------------------------------------
set local session_replication_role = replica;
insert into app.guest_emails (org_id, guest_email_send_id, guest_list_entry_id, to_email, send_state, created_at)
select pg_temp.id('org_a'), pg_temp.id('send_inv'), gen_random_uuid(), 'bulk' || n || '@example.test', 'Queued', now() - interval '1 hour'
from generate_series(1, 1997) n;
set local session_replication_role = origin;
select pg_temp.as_user('carol');
select throws_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), array[(select id from world where key = 'g_pass')], 'Invitation')$$,
  'XR001', 'guest_email_rate: An organization emails up to 2,000 guests a day. Send the rest tomorrow.', 'more than 2,000 in a day is refused');
select lives_ok($$select app.queue_guest_emails((select id from world where key = 'prj_a'), array[(select id from world where key = 'g_none')], 'Invitation')$$,
  'a send that queues nothing new is not counted against the limit');
select pg_temp.as_platform();
set local session_replication_role = replica;
delete from app.guest_emails where to_email like 'bulk%@example.test';
set local session_replication_role = origin;

-- The worker ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select * from app.claim_guest_emails(10)$$, '42501', null, 'staff cannot claim guest emails');
select pg_temp.as_platform();
create temporary table claimed on commit drop as select * from app.claim_guest_emails(50);
grant select on claimed to anon, authenticated;
select is((select count(*)::int from claimed), 2, 'the worker claims the two Queued rows');
select is((select string_agg(email_kind::text || ':' || to_email, ',' order by to_email) from claimed),
  'Invitation:rowan@example.test,Pass:sasha@example.test', 'with what each email needs');
select ok((select bool_and(unsubscribe_token ~ '^xgue_[0-9a-f]{64}$') from claimed), 'each with a fresh unsubscribe token');
select is((select count(*)::int from private.guest_email_unsubscribe_tokens t join claimed c on c.guest_email_id = t.guest_email_id
           where t.token_hash = extensions.digest(c.unsubscribe_token, 'sha256')), 2, 'whose hash is stored');
select is((select count(*)::int from app.claim_guest_emails(50)), 0, 'a claimed row is not claimed again');
select app.finish_guest_email((select guest_email_id from claimed where email_kind = 'Pass'), 'msg-001', null);
select app.finish_guest_email((select guest_email_id from claimed where email_kind = 'Pass'), 'msg-002', 'late duplicate');
select is((select send_state::text || ':' || provider_message_id from app.guest_emails where id = (select guest_email_id from claimed where email_kind = 'Pass')),
  'Sent:msg-001', 'finishing a Sent row again changes nothing');
select app.finish_guest_email((select guest_email_id from claimed where email_kind = 'Invitation'), null, 'SMTP 451 try later');
select is((select send_state::text || ':' || attempts from app.guest_emails where id = (select guest_email_id from claimed where email_kind = 'Invitation')),
  'Queued:1', 'a failed attempt goes back to the queue');
update app.guest_list_entries set deleted_at = now() where id = pg_temp.id('g_req');
select is((select count(*)::int from app.claim_guest_emails(50)), 0, 'a guest deleted since the queue is not sent');
select is((select send_state::text || ':' || skip_reason::text from app.guest_emails where id = (select guest_email_id from claimed where email_kind = 'Invitation')),
  'Skipped:Not Live', 'and is Skipped');

-- Unsubscribe -------------------------------------------------------------------------------------------------------------------------
create function pg_temp.read_only_unsubscribe(p_token text) returns text
language plpgsql as $$
declare
  v_outcome text := '';
begin
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
    perform set_config('transaction_read_only', 'on', true);
    perform api_public.unsubscribe_guest_email(p_token);
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception
    when sqlstate 'ZZ001' then v_outcome := '';
    when others then v_outcome := sqlstate;
  end;
  return v_outcome;
end $$;
select is(pg_temp.read_only_unsubscribe((select unsubscribe_token from claimed where email_kind = 'Pass')), '25006',
  'a read-only call (a GET) unsubscribes nobody');
select is((select count(*)::int from app.suppression_list where address = 'sasha@example.test'), 0, 'and suppresses nothing');
select pg_temp.as_anon();
select is(api_public.unsubscribe_guest_email((select unsubscribe_token from claimed where email_kind = 'Pass')), 'Northwind Live',
  'the token from the email unsubscribes and names the org');
select is(api_public.unsubscribe_guest_email((select unsubscribe_token from claimed where email_kind = 'Pass')), 'Northwind Live', 'again, idempotently');
select is(api_public.unsubscribe_guest_email('xgue_unknown'), null, 'an unknown token answers the same shape and changes nothing');
select pg_temp.as_platform();
select is((select count(*)::int from app.suppression_list where org_id = pg_temp.id('org_a') and address = 'sasha@example.test'
             and reason = 'Unsubscribe' and category_code is null and lifted_at is null), 1, 'the address is suppressed once for every category');
select is((select count(*)::int from app.suppression_list where org_id = pg_temp.id('org_b') and address = 'sasha@example.test'), 0, 'for that org only');
select is((select count(*)::int from private.rate_limit_events where bucket = 'guest_email.token.failure'), 1, 'only the failed lookup counts');
select pg_temp.as_user('carol');
insert into world values ('send_after', app.queue_guest_emails(pg_temp.id('prj_a'), array[pg_temp.id('g_pass')], 'Message', 'Doors at 7', 'Doors open at 7.'));
select is((select send_state::text from app.guest_emails where guest_email_send_id = pg_temp.id('send_after')), 'Suppressed', 'later emails to the address are Suppressed');
select pg_temp.as_platform();
select is((select count(*)::int from cron.job where jobname = 'xos_guest_email' and schedule = '* * * * *'), 1, 'pg_cron asks for guest email every minute');
select lives_ok($$select private.request_guest_email_send()$$, 'the request is a no-op without the Vault secrets');

select * from finish();
rollback;
