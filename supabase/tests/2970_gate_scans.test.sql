-- pgTAP: migration 2970 (B8, G-145), gate scans. Out is never refused; every In refusal carries its reason in decideGate's
-- order and a Granted scan none; the checks hold on every row; record_scan replays keep the direction and refuse a
-- changed one; callers without p_direction still work and get the 0470 columns first; each override refusal; an
-- override is a Granted In row; only the RPC writes override columns; the RPC is in the sync allowlist.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

-- Fixture: zones, a category with grid rows (one open now, one closed), credentials for frank and erin --------------
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'STG', 'Stage') returning id) insert into world select 'zone_stage', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'VIP', 'VIP Deck') returning id) insert into world select 'zone_vip', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id) insert into world select 'cat', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at) values
  (pg_temp.id('cat'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day'),
  (pg_temp.id('cat'), pg_temp.id('zone_vip'), 'ENM-036', now() + interval '1 day', now() + interval '2 days');
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id) insert into world select 'cred', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from) values (pg_temp.id('cat'), pg_temp.id('erin'), now() + interval '1 day') returning id) insert into world select 'cred_future', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to) values (pg_temp.id('cat'), pg_temp.id('gina'), now() - interval '3 days', now() - interval '1 day') returning id) insert into world select 'cred_expired', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('bob')) returning id) insert into world select 'cred_revoked', id from x;
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_revoked');

-- Reasons ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select is((select refusal_reason::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_revoked'))), 'Revoked', 'a revoked credential is denied as Revoked');
select is((select refusal_reason::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_future'))), 'Not Yet Valid', 'a future credential is denied as Not Yet Valid');
select is((select refusal_reason::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_expired'))), 'Expired', 'an expired credential is denied as Expired');
select is((select refusal_reason::text from app.record_scan(pg_temp.id('zone_stage'), pg_temp.id('cred'))), 'No Zone Access', 'a zone missing from the grid is No Zone Access');
select is((select refusal_reason::text from app.record_scan(pg_temp.id('zone_vip'), pg_temp.id('cred'))), 'Outside Window', 'a grid row closed now is Outside Window');
select is((select row(result::text, refusal_reason::text)::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'))), '(Granted,)', 'a granted scan has no reason');

-- Exit is never refused ----------------------------------------------------------------------------------------------------
select is((select row(result::text, direction::text, refusal_reason::text)::text
           from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_revoked'), null, null, null, null, 'Out')),
  '(Granted,Out,)', 'an Out scan of a revoked credential is Granted with no reason');
select is((select result::text from app.record_scan(pg_temp.id('zone_stage'), pg_temp.id('cred_expired'), p_direction => 'Out')), 'Granted',
  'an Out scan of an expired credential at a zone off the grid is Granted');
select is((select result::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '01920000-0000-7000-8000-00000000b970'::uuid,
  now() - interval '1 minute', 'Granted', 'Out')), 'Granted', 'Compass sends an Out scan with its device time and an offline Granted');

-- Callers without p_direction ----------------------------------------------------------------------------------------------
select is((select direction::text from app.record_scan(p_zone_id => pg_temp.id('zone'), p_credential_id => pg_temp.id('cred'))), 'In',
  'a call by name without p_direction stores In');
select is((select array_to_string(p.proargnames[8:], ',') from pg_catalog.pg_proc p where p.oid = 'app.record_scan'::regproc),
  'id,credential_id,credential_number,holder_name,category_code,zone_id,zone_code,scanned_at,result,replayed,direction,refusal_reason',
  'the 0470 columns come first in their order, then direction and refusal_reason');

-- Replays ------------------------------------------------------------------------------------------------------------------
select is((select replayed from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '01920000-0000-7000-8000-00000000b970'::uuid,
  now() - interval '1 minute', 'Granted', 'Out')), true, 'replaying an Out scan returns the stored row');
select is((select direction::text from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '01920000-0000-7000-8000-00000000b970'::uuid,
  now() - interval '1 minute', 'Granted', 'Out')), 'Out', 'with its direction');
select throws_ok($$select * from app.record_scan((select id from world where key = 'zone'), (select id from world where key = 'cred'), null,
  '01920000-0000-7000-8000-00000000b970'::uuid, now() - interval '1 minute', 'Granted', 'In')$$,
  'XR001', 'scan_id_taken: Another scan already uses this id.', 'replaying the id with the other direction is refused');

-- Checks hold on every row -------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from app.access_scans where refusal_reason is not null and result <> 'Denied'), 0, 'access_scans_refusal holds on every row');
select is((select count(*)::int from app.access_scans where result = 'Denied' and refusal_reason is null), 0, 'every Denied row inserted since 2970 has a reason');
select throws_ok($$insert into app.access_scans (org_id, credential_id, zone_id, override_of_scan_id, override_reason)
  values ((select id from world where key = 'org_a'), (select id from world where key = 'cred'), (select id from world where key = 'zone'),
          gen_random_uuid(), 'Let in')$$,
  'XR001', 'scan_override_rpc: An override is recorded through app.override_access_scan.', 'a direct insert naming an override is refused');
select is((select count(*)::int from private.sync_rpcs where rpc = 'app.override_access_scan'), 1, 'override_access_scan is in the sync allowlist');

-- Overrides ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into world select 'denied', id from app.record_scan(pg_temp.id('zone_vip'), pg_temp.id('cred'), null, '01920000-0000-7000-8000-00000000b971'::uuid);
insert into world select 'denied_revoked', id from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_revoked'));
insert into world select 'granted', id from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'));
insert into world select 'denied_erin', id from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_future'));
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), 'Escorted by the stage manager')$$,
  '42501', null, 'a Field member without credentials.credential.issue cannot override');

select pg_temp.as_user('dave');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'granted'), 'Escorted')$$,
  'XR001', 'scan_not_denied: Only a denied entry scan is overridden.', 'a Granted scan is not overridden');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied_revoked'), 'Escorted')$$,
  'XR001', 'scan_override_revoked: A revoked credential is never let in. Issue a new one.', 'a Revoked denial is never overridden');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), '   ')$$,
  'XR001', 'scan_override_reason: Say why in 1 to 300 characters.', 'a reason is required');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), repeat('x', 301))$$,
  'XR001', 'scan_override_reason: Say why in 1 to 300 characters.', 'a reason is at most 300 characters');
select is((select row(result::text, direction::text, replayed, overridden_scan_id = pg_temp.id('denied'))::text
           from app.override_access_scan(pg_temp.id('denied'), 'Escorted by the stage manager', '01920000-0000-7000-8000-00000000b972'::uuid)),
  '(Granted,In,f,t)', 'a Coordinator with issue overrides a recent denial: a Granted In row naming it');
select is((select replayed from app.override_access_scan(pg_temp.id('denied'), 'Escorted by the stage manager', '01920000-0000-7000-8000-00000000b972'::uuid)),
  true, 'replaying the override id returns the stored row');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), 'Again')$$,
  'XR001', 'scan_override_taken: This denial was already overridden.', 'a second override is refused');
select pg_temp.as_user('carol');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), 'Escorted', '01920000-0000-7000-8000-00000000b972'::uuid)$$,
  'XR001', 'scan_id_taken: Another scan already uses this id.', 'another person cannot replay the override id');
select pg_temp.as_platform();
select is((select row(result::text, direction::text, override_reason, created_by = pg_temp.id('dave'))::text
           from app.access_scans where override_of_scan_id = pg_temp.id('denied')),
  '(Granted,In,"Escorted by the stage manager",t)', 'the override row keeps the reason and who overrode');
select is((select count(*)::int from app.access_scans where override_of_scan_id = pg_temp.id('denied')), 1, 'one override row');

select pg_temp.as_user('erin');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied_erin'), 'My own badge')$$,
  '42501', null, 'a Collaborator without issue cannot override');
select pg_temp.as_platform();
select pg_temp.as_user('carol');
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from) values (pg_temp.id('cat'), pg_temp.id('dave'), now() + interval '1 day') returning id) insert into world select 'cred_dave', id from x;
select pg_temp.as_user('frank');
insert into world select 'denied_dave', id from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred_dave'));
select pg_temp.as_user('dave');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied_dave'), 'It is me')$$,
  'XR001', 'scan_override_self: Nobody overrides a denial of their own credential.', 'nobody overrides a denial of their own credential');
select pg_temp.as_user('carol');
select lives_ok($$select * from app.override_access_scan((select id from world where key = 'denied_dave'), 'Early load-in approved')$$,
  'a Manager overrides it for them');

-- Stale and revoked since the denial ----------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into world select 'denied_old', id from app.record_scan(pg_temp.id('zone_vip'), pg_temp.id('cred'));
select pg_temp.as_platform();
set local session_replication_role = replica;
update app.access_scans set created_at = created_at - interval '16 minutes' where id = pg_temp.id('denied_old');
set local session_replication_role = origin;
select pg_temp.as_user('carol');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied_old'), 'Escorted')$$,
  'XR001', 'scan_override_stale: A denial is overridden within 15 minutes. Scan the credential again.', 'a denial older than 15 minutes is stale');
select pg_temp.as_user('frank');
insert into world select 'denied_then_revoked', id from app.record_scan(pg_temp.id('zone_vip'), pg_temp.id('cred'));
select pg_temp.as_user('carol');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied_then_revoked'), 'Escorted')$$,
  'XR001', 'scan_override_revoked: A revoked credential is never let in. Issue a new one.',
  'a credential revoked since the denial is never let in, whatever the reason was');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), 'Escorted')$$,
  '42501', null, 'another org cannot see the scan');
select pg_temp.as_anon();
select throws_ok($$select * from app.override_access_scan((select id from world where key = 'denied'), 'Escorted')$$,
  '42501', null, 'anon cannot override');
select pg_temp.as_platform();

select * from finish();
rollback;
