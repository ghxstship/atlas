-- pgTAP: Org cancellation (Section 14.7, A36). The Owner cancels by typing the name; the subscription
-- ends; the org is read-only for 30 days (reads and the full export work, writes are refused); the Owner
-- may reactivate inside the window, on the Access plan; partners with clients cannot cancel.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(32);

-- Refusals before cancelling -------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select app.cancel_organization((select id from world where key = 'org_a'), 'Northwind Live', 'Closing down.')$$,
  '42501', null, 'an Admin cannot cancel the org (Owner only)');
select pg_temp.as_user('xavier');
select throws_ok($$select app.cancel_organization((select id from world where key = 'org_a'), 'Northwind Live', 'Closing down.')$$,
  '42501', null, 'another org''s Owner cannot cancel it');
select pg_temp.as_user('alice');
select throws_ok($$select app.cancel_organization((select id from world where key = 'org_a'), 'Northwind', 'Closing down.')$$,
  'XR001', 'org_name_mismatch: Type the organization''s name exactly to confirm.', 'the name must be typed exactly');
select throws_ok($$select app.cancel_organization((select id from world where key = 'org_a'), 'Northwind Live', ' ')$$,
  'XR001', 'org_cancel_reason: Say why the organization is canceled, in up to 1,000 characters.', 'a reason is required');
select pg_temp.as_user('paul');
select throws_ok($$select app.cancel_organization((select id from world where key = 'org_p'), 'Bluewater Partners', 'Closing down.')$$,
  'XR001', 'org_cancel_has_clients: A partner with client orgs cannot cancel; move each client to direct billing first.',
  'a partner with clients cannot cancel');
select pg_temp.as_user('alice');
select is(app.can_export_org(pg_temp.id('org_a')), true, 'the Owner may take the full export at any time');
select pg_temp.as_user('carol');
select is(app.can_export_org(pg_temp.id('org_a')), false, 'a Manager may not');
select throws_ok($$select * from app.org_export_tables((select id from world where key = 'org_a'))$$, '42501', null,
  'and cannot list the export tables');

-- Cancelling -----------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$insert into world select 'cancel', app.cancel_organization((select id from world where key = 'org_a'), 'Northwind Live', 'Season over; moving to another tool.')$$,
  'the Owner cancels with the exact name and a reason');
select is((select read_only_until - canceled_at from app.org_cancellations where id = pg_temp.id('cancel')), interval '30 days',
  'the org is read-only for 30 days');
select is((select purge_after - canceled_at from app.org_cancellations where id = pg_temp.id('cancel')), interval '90 days',
  'and its data is due for deletion at day 90');
select pg_temp.as_platform();
select is((select count(*)::int from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'), 0,
  'the subscription is canceled');
select is((select count(*)::int from app.subscription_state_transitions where org_id = pg_temp.id('org_a') and to_state = 'canceled'),
  1, 'and the ledger records it');
select ok(exists (select 1 from app.audit_events where org_id = pg_temp.id('org_a') and subject_table = 'app.org_cancellations'),
  'the cancellation is in the audit ledger');

-- Read-only window --------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.org_cancellations where org_id = pg_temp.id('org_a')), 1, 'every member sees the cancellation (for the banner)');
select is((select count(*)::int from app.projects where id = pg_temp.id('prj_a')), 1, 'members still read their projects');
select pg_temp.as_user('carol');
select throws_ok($$update app.projects set name = 'Renamed' where id = (select id from world where key = 'prj_a')$$,
  'XR001', 'org_read_only: This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.',
  'but no project can be renamed');
select pg_temp.as_user('alice');
select throws_ok($$insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values ((select id from world where key = 'org_a'), 'New Venue', 'US-FL-MIAMI-DADE', 'America/New_York')$$,
  'XR001', null, 'even the Owner cannot add a venue');
select throws_ok($$insert into app.custom_object_types (org_id, object_key, label, icon)
  values ((select id from world where key = 'org_a'), 'gear', 'Gear', 'box')$$, 'XR001', null, 'nor define a custom object');
select pg_temp.as_platform();
select lives_ok($$update app.projects set updated_at = now() where id = (select id from world where key = 'prj_a')$$,
  'the platform (workers, retention) still writes');
select ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id')
    and format('app.%s', c.relname) not in (select table_name from private.read_only_exempt_tables)
    and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 't15_refuse_read_only_org')),
  'every tenant table outside the reviewed exemptions carries the read-only guard');
select pg_temp.as_user('alice');
select ok((select count(*) from app.org_export_tables(pg_temp.id('org_a'))) > 50, 'the Owner lists the tables of the full export');
select is((select count(*)::int from app.org_export_tables(pg_temp.id('org_a')) where table_name = 'pay_rates' and 'rate_minor' = any (columns)), 0,
  'Restricted columns are left out of the export');
select lives_ok($$select app.record_org_export((select id from world where key = 'org_a'), 120, 4000, 3, repeat('a', 64))$$,
  'the Owner logs the export she downloaded');
select throws_ok($$select app.cancel_organization((select id from world where key = 'org_a'), 'Northwind Live', 'Again.')$$,
  'XR001', 'org_already_canceled: This organization is already canceled.', 'an org is canceled once');
select pg_temp.as_user('bob');
select throws_ok($$select app.reactivate_organization((select id from world where key = 'org_a'))$$, '42501', null, 'an Admin cannot reactivate');

-- Reactivation ------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok($$select app.reactivate_organization((select id from world where key = 'org_a'))$$, 'the Owner reactivates within 30 days');
select lives_ok($$insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values ((select id from world where key = 'org_a'), 'New Venue', 'US-FL-MIAMI-DADE', 'America/New_York')$$,
  'writes work again');
select pg_temp.as_user('carol');
select throws_like($$update app.projects set name = 'Renamed' where id = (select id from world where key = 'prj_a')$$,
  'plan_limit_read_only:%', 'the org restarts on Access, where the seats past its limit are read-only (2070)');
select pg_temp.as_user('alice');
select throws_ok($$select app.reactivate_organization((select id from world where key = 'org_a'))$$,
  'XR001', 'org_not_canceled: This organization is not canceled.', 'a live org is not reactivated');

-- Past the window --------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.org_cancellations (org_id, reason, canceled_at, read_only_until, purge_after)
values (pg_temp.id('org_b'), 'Done.', now() - interval '31 days', now() - interval '1 day', now() + interval '59 days');
select pg_temp.as_user('xavier');
select throws_ok($$select app.reactivate_organization((select id from world where key = 'org_b'))$$,
  'XR001', 'org_reactivation_window: An organization can be reactivated during the 30 days after it was canceled.',
  'after 30 days the org cannot be reactivated');
select pg_temp.as_platform();
select throws_ok($$update app.org_cancellations set reason = 'Edited.' where org_id = (select id from world where key = 'org_b')$$,
  'XR001', 'org_cancellation_immutable: A cancellation keeps its org, time and reason; it is reactivated once.', 'a cancellation keeps its reason');

select * from finish();
rollback;
