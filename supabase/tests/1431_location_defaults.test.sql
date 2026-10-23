-- pgTAP: location and venue defaults (A86, RRR-131, finding A65-004, Section 4.5.6 org settings item 9).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

select pg_temp.as_user('dave');
select throws_ok($$select app.set_location_defaults(pg_temp.id('org_a'), 'US-FL-MIAMI-DADE', 'America/New_York')$$, '42501', null,
  'a member without org.locations.write cannot set location defaults');
select throws_ok($$insert into app.org_location_defaults (org_id, time_zone) values (pg_temp.id('org_a'), 'America/New_York')$$,
  '42501', null, 'nor write the table directly');

select pg_temp.as_user('bob');
select lives_ok($$select app.set_location_defaults(pg_temp.id('org_a'), 'US-FL-MIAMI-DADE', 'America/New_York')$$,
  'an admin sets the jurisdiction and time zone a new venue starts with');
select is((select concat_ws('|', jurisdiction_id, time_zone) from app.org_location_defaults
           where org_id = pg_temp.id('org_a') and deleted_at is null), 'US-FL-MIAMI-DADE|America/New_York', 'both are stored');
select lives_ok($$select app.set_location_defaults(pg_temp.id('org_a'), '', 'Europe/London')$$,
  'an empty jurisdiction clears it');
select is((select count(*)::integer from app.org_location_defaults where org_id = pg_temp.id('org_a')), 1,
  'one row per org: saving again updates it');
select is((select coalesce(jurisdiction_id, 'none') || '|' || time_zone from app.org_location_defaults
           where org_id = pg_temp.id('org_a') and deleted_at is null), 'none|Europe/London', 'the update applied');

select throws_ok($$select app.set_location_defaults(pg_temp.id('org_a'), 'ZZ-NOWHERE', 'Europe/London')$$, 'XR001',
  'jurisdiction_unknown: ZZ-NOWHERE is not a canon jurisdiction.', 'an unknown jurisdiction is refused');
select throws_ok($$select app.set_location_defaults(pg_temp.id('org_a'), null, 'Mars/Olympus_Mons')$$, 'XR001', null,
  'a time zone the IANA database does not know is refused');

select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a')
           and action in ('org_location_defaults.insert', 'org_location_defaults.update')) >= 2, 'changes are audited');

select pg_temp.as_user('dave');
select is((select time_zone from app.org_location_defaults where deleted_at is null), 'Europe/London',
  'every member reads the defaults, so the venue form can start from them');

select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.org_location_defaults), 0, 'no cross-tenant reads');
select throws_ok($$select app.set_location_defaults(pg_temp.id('org_a'), null, 'Europe/London')$$, '42501', null,
  'an owner of another org cannot set them');

select * from finish();
rollback;
