-- pgTAP: migration 2913, B2 (RRR-226, ADR 0141). Outside delivery of stakeholder packs: a manual send queues an
-- Invite or a Resend per recipient with at most 3 an hour, the scheduler makes one Scheduled delivery per due slot for
-- each recipient who is not revoked or unsubscribed and never a duplicate, a schedule whose next slot falls after the
-- pack's expiry is paused, minting a link revokes the earlier attempt's and never carries the access code, a failed send
-- leaves no working link, and a sent one logs Sent.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(37);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update, delete on k to public;

create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select id from k where key = p_key $$;
create function pg_temp.v(p_key text) returns text language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.try(p_user text, p_sql text) returns text
language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  begin
    execute p_sql;
  exception when sqlstate 'XR001' then
    perform pg_temp.as_platform();
    return split_part(sqlerrm, ':', 1);
  when others then
    perform pg_temp.as_platform();
    return sqlstate;
  end;
  perform pg_temp.as_platform();
  return 'ok';
end $$;

create function pg_temp.latest(p_recipient text) returns uuid language sql stable as $$
  select d.id from app.stakeholder_pack_deliveries d where d.recipient_id = pg_temp.k(p_recipient)
  order by d.created_at desc, d.id desc limit 1 $$;

select pg_temp.as_user('carol');
insert into k values ('pack', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Supplier pack', now() + interval '30 days', 'Hello.'), null);
insert into k select 'r1', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Sol Supplier', 'sol@supplier.test') r;
insert into k select 'r2', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Tia Supplier', 'tia@supplier.test') r;
insert into k select 'r3', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack'), 'Uma Supplier', 'uma@supplier.test') r;
select pg_temp.as_platform();

select is((select max_attempts::int from private.job_kinds where code = 'pack.deliver'), 5, 'pack.deliver is a registered job kind');

-- Manual sends --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k values ('sent', null, app.send_stakeholder_pack(pg_temp.k('pack'))::text);
select pg_temp.as_platform();
select is(pg_temp.v('sent'), '3', 'Send invite queues one delivery per live recipient');
select is((select count(*)::int from app.stakeholder_pack_deliveries where stakeholder_pack_id = pg_temp.k('pack') and delivery_kind = 'Invite'), 3,
  'each an Invite');
select is((select count(*)::int from app.job_queue where job_kind = 'pack.deliver'
  and subject_id in (select id from app.stakeholder_pack_deliveries where stakeholder_pack_id = pg_temp.k('pack'))), 3, 'and a pack.deliver job each');
select is(pg_temp.try('dave', format($$select app.send_stakeholder_pack(%L)$$, pg_temp.k('pack'))), '42501',
  'someone who does not manage the pack sends nothing');

-- Minting and finishing --------------------------------------------------------------------------------------------------
insert into k select 'm1', pg_temp.latest('r1'), m.token || ' ' || m.unsubscribe_token || ' ' || m.expires_at::text || ' ' || m.email::text
from app.mint_stakeholder_pack_link(pg_temp.latest('r1')) m;
select ok(split_part(pg_temp.v('m1'), ' ', 1) ~ '^xpkl_[0-9a-f]{64}$' and split_part(pg_temp.v('m1'), ' ', 2) ~ '^xpku_[0-9a-f]{64}$',
  'minting answers an xpkl_ link token and an xpku_ unsubscribe token');
select ok((select expires_at <= now() + interval '7 days' from private.stakeholder_pack_links
  where token_hash = extensions.digest(split_part(pg_temp.v('m1'), ' ', 1), 'sha256')), 'the link expires within 7 days');
select ok(pg_temp.v('m1') like '%"recipient_email": "sol@supplier.test"%' and pg_temp.v('m1') like '%"locale": "en-US"%'
  and pg_temp.v('m1') not like '%' || pg_temp.v('r1') || '%', 'the email names the recipient and locale and never carries the access code');
select app.mint_stakeholder_pack_link(pg_temp.k('m1'));
select is((select count(*)::int from private.stakeholder_pack_links where stakeholder_pack_delivery_id = pg_temp.k('m1') and revoked_at is null), 1,
  'minting again for a retried delivery revokes the earlier attempt''s link');
select app.finish_stakeholder_pack_delivery(pg_temp.k('m1'), false, null, 'Mailbox unavailable.');
select ok((select delivery_status = 'Failed' from app.stakeholder_pack_deliveries where id = pg_temp.k('m1'))
  and (select count(*) = 0 from private.stakeholder_pack_links where stakeholder_pack_delivery_id = pg_temp.k('m1') and revoked_at is null),
  'a failed send fails the delivery and leaves no working link');
select app.mint_stakeholder_pack_link(pg_temp.latest('r2'));
select app.finish_stakeholder_pack_delivery(pg_temp.latest('r2'), true, 'msg-1');
select ok((select delivery_status = 'Sent' and sent_at is not null from app.stakeholder_pack_deliveries where id = pg_temp.latest('r2'))
  and (select count(*) = 1 from app.stakeholder_pack_events where recipient_id = pg_temp.k('r2') and action = 'Sent'),
  'a sent email records Sent and logs it');
select pg_temp.as_user('carol');
select app.send_stakeholder_pack(pg_temp.k('pack'), array[pg_temp.k('r2')]);
select pg_temp.as_platform();
select is((select delivery_kind from app.stakeholder_pack_deliveries where id = pg_temp.latest('r2')), 'Resend', 'a later send to the same recipient is a Resend');
select pg_temp.as_user('carol');
select app.send_stakeholder_pack(pg_temp.k('pack'), array[pg_temp.k('r2')]);
insert into k values ('fourth', null, app.send_stakeholder_pack(pg_temp.k('pack'), array[pg_temp.k('r2')])::text);
select pg_temp.as_platform();
select is(pg_temp.v('fourth'), '0', 'a fourth manual send to one recipient within the hour is skipped');

-- Schedules ---------------------------------------------------------------------------------------------------------
-- An hour at least 11 hours from now, so the next slot never falls inside a short expiry by chance.
insert into k values ('hour', null, ((extract(hour from now() at time zone 'UTC')::int + 12) % 24)::text);
select is(pg_temp.try('carol', format($$select app.set_stakeholder_pack_schedule(%L, 'Daily', %s::smallint, null, null, 'UTC')$$,
  pg_temp.k('pack'), pg_temp.v('hour'))), 'ok', 'a daily schedule is set');
select pg_temp.as_anon();
select set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
select api_public.unsubscribe_stakeholder_pack(split_part(pg_temp.v('m1'), ' ', 2), '198.51.100.7');
select pg_temp.as_platform();
select pg_temp.as_user('carol');
select app.revoke_stakeholder_pack_recipient(pg_temp.k('r3'));
select pg_temp.as_platform();
update app.stakeholder_pack_schedules set next_run_at = now() - interval '1 minute' where stakeholder_pack_id = pg_temp.k('pack');
insert into k values ('q1', null, app.queue_due_pack_schedules()::text);
insert into k values ('q2', null, app.queue_due_pack_schedules()::text);
select is(pg_temp.v('q1'), '1', 'a due slot queues one Scheduled delivery per recipient who is not revoked or unsubscribed');
select is(pg_temp.v('q2'), '0', 'running the scheduler again in the same slot makes no duplicate');
select ok((select next_run_at > now() and paused_at is null from app.stakeholder_pack_schedules where stakeholder_pack_id = pg_temp.k('pack')),
  'and the schedule moves to its next slot');

select pg_temp.as_user('carol');
select app.update_stakeholder_pack(pg_temp.k('pack'), 'Supplier pack', 'Hello.', null, now() + interval '1 hour');
select pg_temp.as_platform();
update app.stakeholder_pack_schedules set next_run_at = now() - interval '1 minute' where stakeholder_pack_id = pg_temp.k('pack');
select app.queue_due_pack_schedules();
select ok((select paused_at is not null from app.stakeholder_pack_schedules where stakeholder_pack_id = pg_temp.k('pack')),
  'a schedule whose next slot falls after the pack''s expiry is paused');
select is(pg_temp.try('carol', format($$select app.set_stakeholder_pack_schedule(%L, 'Weekly', %s::smallint, 1::smallint, null, 'UTC')$$,
  pg_temp.k('pack'), pg_temp.v('hour'))), 'stakeholder_pack_schedule_past_expiry', 'a schedule whose first slot falls after the expiry is refused');

-- The org's suppression list -------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k values ('pack2', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Second pack', now() + interval '30 days'), null);
insert into k select 'p2a', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack2'), 'Tia Supplier', 'tia@supplier.test') r;
insert into k select 'p2b', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack2'), 'Bo Bounce', 'bo@supplier.test') r;
insert into k select 'p2c', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack2'), 'Ada Open', 'ada@supplier.test') r;
select pg_temp.as_platform();
insert into app.suppression_list (org_id, channel, address, reason) values
  (pg_temp.id('org_a'), 'Email', 'tia@supplier.test', 'Unsubscribe'),
  (pg_temp.id('org_a'), 'Email', 'bo@supplier.test', 'Hard Bounce');
select pg_temp.as_user('carol');
insert into k values ('sent2', null, app.send_stakeholder_pack(pg_temp.k('pack2'))::text);
select pg_temp.as_platform();
select is(pg_temp.v('sent2'), '1', 'a send skips an address unsubscribed from another pack of the org, and a Hard Bounce');
select is((select count(*)::int from app.stakeholder_pack_deliveries where recipient_id = pg_temp.k('p2a')), 0, 'nothing is queued for the unsubscribed address');
select pg_temp.as_user('carol');
select app.set_stakeholder_pack_schedule(pg_temp.k('pack2'), 'Daily', pg_temp.v('hour')::smallint, null, null, 'UTC');
select pg_temp.as_platform();
update app.stakeholder_pack_schedules set next_run_at = now() - interval '1 minute' where stakeholder_pack_id = pg_temp.k('pack2');
select is(app.queue_due_pack_schedules(), 1, 'the scheduler skips them too');
-- A row added after a delivery was queued marks it Skipped, with the reason.
insert into app.suppression_list (org_id, channel, address, reason) values (pg_temp.id('org_a'), 'Email', 'ada@supplier.test', 'Complaint');
select is((select count(*)::int from app.mint_stakeholder_pack_link(pg_temp.latest('p2c'))), 0, 'minting for a suppressed address answers nothing');
select is((select delivery_status || ': ' || last_error from app.stakeholder_pack_deliveries where id = pg_temp.latest('p2c')),
  'Skipped: The address is on the organization''s suppression list.', 'and the delivery says why');

-- A retried attempt's link -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k values ('pack3', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Third pack', now() + interval '30 days'), null);
insert into k select 'p3', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('pack3'), 'Rae Retry', 'rae@supplier.test') r;
select app.send_stakeholder_pack(pg_temp.k('pack3'));
select pg_temp.as_platform();
select is((select org_id from private.stakeholder_pack_links l where l.recipient_id = pg_temp.k('p3') limit 1), null, 'no link before minting');
select count(*) from app.mint_stakeholder_pack_link(pg_temp.latest('p3'));
select is((select org_id from private.stakeholder_pack_links l where l.recipient_id = pg_temp.k('p3') limit 1), pg_temp.id('org_a'), 'a minted link carries the org');
select ok((select (m.email ? 'time_zone') from app.mint_stakeholder_pack_link(pg_temp.latest('p3')) m), 'the email data names the zone to show the expiry in');
select app.finish_stakeholder_pack_delivery(pg_temp.latest('p3'), false, null, 'Provider down', true);
select is((select delivery_status from app.stakeholder_pack_deliveries where id = pg_temp.latest('p3')), 'Queued', 'a failed attempt that will retry stays Queued');
select is((select count(*)::int from private.stakeholder_pack_links l where l.recipient_id = pg_temp.k('p3') and l.revoked_at is null), 0, 'and leaves no working link');

-- A slot follows its zone across a daylight-saving change ---------------------------------------------------------------------
-- 9:00 in New York is 13:00 UTC before the November 2027 change and 14:00 UTC after it; March 2027 is the reverse.
select is(private.next_schedule_run('Daily', 9::smallint, null, null, 'America/New_York', timestamptz '2027-11-06 13:30+00'),
  timestamptz '2027-11-07 14:00+00', 'a daily slot keeps its local hour when the clocks go back');
select is(private.next_schedule_run('Daily', 9::smallint, null, null, 'America/New_York', timestamptz '2027-03-13 14:30+00'),
  timestamptz '2027-03-14 13:00+00', 'and when they go forward');
select pg_temp.as_user('carol');
insert into k values ('zoned', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Zoned pack', now() + interval '30 days'), null);
select app.set_stakeholder_pack_schedule(pg_temp.k('zoned'), 'Daily', 9::smallint, null, null, 'America/New_York');
select pg_temp.as_platform();
update app.stakeholder_pack_schedules set next_run_at = now() - interval '1 minute' where stakeholder_pack_id = pg_temp.k('zoned');
select app.queue_due_pack_schedules();
select is((select extract(hour from next_run_at at time zone 'America/New_York')::int from app.stakeholder_pack_schedules where stakeholder_pack_id = pg_temp.k('zoned')),
  9, 'the scheduler moves a schedule to its next slot in the schedule''s own zone');

-- Retiring what a pack held ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k values ('old', app.create_stakeholder_pack(pg_temp.id('prj_a'), 'Old pack', now() + interval '1 day'), null);
insert into k select 'old_r', r.recipient_id, r.access_code from app.add_stakeholder_pack_recipient(pg_temp.k('old'), 'Old Recipient', 'old@supplier.test') r;
select pg_temp.as_platform();
select is(private.retire_ended_stakeholder_packs(), 0, 'a pack that ended within the year is kept');
alter table app.stakeholder_packs disable trigger user;
update app.stakeholder_packs set expires_at = now() - interval '13 months' where id = pg_temp.k('old');
alter table app.stakeholder_packs enable trigger user;
select is(private.retire_ended_stakeholder_packs(), 1, 'one year after a pack ended the job takes it');
select ok((select deleted_at is not null from app.stakeholder_packs where id = pg_temp.k('old'))
  and (select deleted_at is not null from app.stakeholder_pack_recipients where id = pg_temp.k('old_r')),
  'the pack and its recipients are soft-deleted');
alter table app.stakeholder_packs disable trigger user;
alter table app.stakeholder_pack_recipients disable trigger user;
update app.stakeholder_pack_recipients set deleted_at = now() - interval '13 months' where id = pg_temp.k('old_r');
update app.stakeholder_packs set deleted_at = now() - interval '13 months' where id = pg_temp.k('old');
alter table app.stakeholder_pack_recipients enable trigger user;
alter table app.stakeholder_packs enable trigger user;
select private.purge_table('app.stakeholder_pack_recipients');
select private.purge_table('app.stakeholder_packs');
select ok(not exists (select 1 from app.stakeholder_packs where id = pg_temp.k('old'))
  and not exists (select 1 from app.stakeholder_pack_recipients where id = pg_temp.k('old_r')),
  'and purged after their retention, so a non-user''s name and email go');
select ok(exists (select 1 from cron.job where jobname = 'xos_retire_ended_stakeholder_packs'), 'the job runs daily');

select * from finish();
rollback;
