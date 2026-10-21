-- pgTAP: migration 1420, kiosk re-keying (A85, RRR-130). A device key that names no live kiosk (never registered,
-- revoked or retired) is answered kiosk_device_unregistered whatever member and PIN come with it: the same answer
-- for every such key, decided before the member or PIN are looked at, with no failure counted and no PIN touched.
-- A live kiosk keeps its PIN refusal, failure count and rate limit, and still records punches.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(15);

create temporary table kiosk (key text primary key, id uuid, device_key text);
grant select, insert, update on kiosk to public;

select pg_temp.as_user('bob');
insert into kiosk select 'live', r.kiosk_device_id, r.device_key
  from app.register_kiosk_device(pg_temp.id('org_a'), 'Dock Gate Kiosk', pg_temp.id('prj_a')) r;
insert into kiosk select 'retired', r.kiosk_device_id, r.device_key
  from app.register_kiosk_device(pg_temp.id('org_a'), 'Old Gate Kiosk', pg_temp.id('prj_a')) r;
insert into kiosk select 'revoked', r.kiosk_device_id, r.device_key
  from app.register_kiosk_device(pg_temp.id('org_a'), 'Lost Tablet', pg_temp.id('prj_a')) r;
select app.set_kiosk_pin(pg_temp.id('frank@org_a'), '4821');
update app.kiosk_devices set deleted_at = now() where id = (select id from kiosk where key = 'retired');
select pg_temp.as_platform();
update app.kiosk_devices set revoked_at = now() where id = (select id from kiosk where key = 'revoked');
insert into kiosk values ('unknown', null, 'xkio_' || encode(extensions.gen_random_bytes(32), 'hex'));

create function pg_temp.punch(p_kiosk text, p_member text, p_pin text, p_kind app.punch_kind default 'In')
returns text language sql as $$
  select refusal from app.kiosk_punch((select device_key from kiosk where key = p_kiosk), pg_temp.id(p_member), p_pin,
    private.uuid_v7(), p_kind, now())
$$;

create function pg_temp.failures(p_kiosk text) returns integer language sql as $$
  select count(*)::integer from private.rate_limit_events e
  where e.bucket = 'kiosk_pin.failure' and e.subject_hash = extensions.digest((select device_key from kiosk where key = p_kiosk), 'sha256')
$$;

select is(pg_temp.punch('unknown', 'frank@org_a', '4821'), 'kiosk_device_unregistered',
  'a key no kiosk was ever registered with is answered as unregistered');
select is(pg_temp.punch('retired', 'frank@org_a', '4821'), 'kiosk_device_unregistered',
  'a retired kiosk gets the same answer, even with the right member and PIN');
select is(pg_temp.punch('revoked', 'frank@org_a', '4821'), 'kiosk_device_unregistered',
  'and so does a revoked kiosk');
select is(pg_temp.punch('unknown', 'xavier@org_b', '0000'), 'kiosk_device_unregistered',
  'the answer is the same for a member of another org and a wrong PIN: it says nothing about members or PINs');
select results_eq(
  $$select punch_id is not null, time_entry_id, effective_at, skew_flagged
    from app.kiosk_punch((select device_key from kiosk where key = 'unknown'), pg_temp.id('frank@org_a'), '4821',
      private.uuid_v7(), 'In', now())$$,
  $$values (true, null::uuid, null::timestamptz, null::boolean)$$,
  'the unregistered answer carries nothing but the punch id');

select is(pg_temp.failures('unknown') + pg_temp.failures('retired'), 0, 'an unregistered device counts no failure');
select is((select failed_attempts::integer from app.kiosk_pins where membership_id = pg_temp.id('frank@org_a') and deleted_at is null),
  0, 'and never reaches the PIN, so the member''s failure count is untouched');
select is((select count(*)::integer from app.clock_punches where membership_id = pg_temp.id('frank@org_a')), 0,
  'and records no punch');

select is(pg_temp.punch('live', 'frank@org_a', '0000'), 'kiosk_pin_rejected', 'a live kiosk still refuses a wrong PIN');
select is(pg_temp.failures('live'), 1, 'and counts it against the device');
select is(pg_temp.punch('live', 'xavier@org_b', '4821'), 'kiosk_pin_rejected',
  'a member of another org at a live kiosk gets the PIN refusal, not the device one');
select is(pg_temp.punch('live', 'frank@org_a', '4821'), null, 'the right PIN at a live kiosk records the punch');

insert into private.rate_limit_events (bucket, subject_hash)
select 'kiosk_pin.failure', extensions.digest((select device_key from kiosk where key = 'live'), 'sha256')
from generate_series(1, 20);
select is(pg_temp.punch('live', 'frank@org_a', '4821', 'Out'), 'kiosk_rate_limited', 'a live kiosk over its failure limit is rate limited');

insert into private.rate_limit_events (bucket, subject_hash)
select 'kiosk_pin.failure', extensions.digest((select device_key from kiosk where key = 'retired'), 'sha256')
from generate_series(1, 20);
select is(pg_temp.punch('retired', 'frank@org_a', '4821'), 'kiosk_device_unregistered',
  'a retired kiosk with old failures keeps the unregistered answer instead of the rate limit');

-- The SQLSTATE a read-only call raises, in a subtransaction that always rolls back.
create function pg_temp.read_only_state(p_kiosk text) returns text language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform pg_temp.punch(p_kiosk, 'frank@org_a', '4821');
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception when others then
    return sqlstate;
  end;
end $$;
select is(pg_temp.read_only_state('unknown') || ' ' || pg_temp.read_only_state('live'), '25006 25006',
  'a read-only call is refused before the device is looked up, so it cannot tell a live key from an unknown one (A69-001)');

select * from finish();
rollback;
