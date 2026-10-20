-- pgTAP: org deletion and the day-90 purge (1351, A79, finding A65-015, Section 14.7). Deletion needs the Owner, step-up
-- and the typed name, makes the org read-only and can be recovered for 7 days. When an org is due, the lifecycle job
-- writes a deletion certificate, the worker deletes its storage objects, the job deletes every row through the tenant
-- purge, and the certificate outlives the org. A legal hold holds the purge; rows of another org block it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(44);

-- A session that passed a second factor just now (the amr entry real tokens carry; A77, 1330).
create function pg_temp.as_stepped_up(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated',
    'aal', 'aal2', 'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint - 60),
      json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Step-up and the typed name -------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_like($$select app.request_org_deletion((select id from world where key = 'org_b'), 'Harbor Lights Productions', 'Closing down.')$$,
  'step_up_required:%', 'deleting an org needs step-up');
select pg_temp.as_stepped_up('xavier');
select throws_like($$select app.request_org_deletion((select id from world where key = 'org_b'), 'Harbor Lights', 'Closing down.')$$,
  'org_name_mismatch:%', 'and the org''s name typed exactly');
select pg_temp.as_stepped_up('bob');
select throws_ok($$select app.request_org_deletion((select id from world where key = 'org_a'), 'Northwind Live', 'Not mine.')$$,
  '42501', null, 'an Admin cannot delete the org');
select pg_temp.as_stepped_up('paul');
select throws_like($$select app.request_org_deletion((select id from world where key = 'org_p'), 'Bluewater Partners', 'Done.')$$,
  'org_delete_has_clients:%', 'a partner with client orgs cannot be deleted');

-- Request, read-only, recovery ------------------------------------------------------------------------------------
select pg_temp.as_stepped_up('xavier');
insert into world select 'del_b', app.request_org_deletion(pg_temp.id('org_b'), 'Harbor Lights Productions', 'We are closing down.');
select ok(pg_temp.id('del_b') is not null, 'the Owner asks for deletion with step-up');
select pg_temp.as_platform();
select is((select recover_until - requested_at from app.org_deletion_requests where id = pg_temp.id('del_b')), interval '7 days',
  'a 7-day recovery window applies');
select is((select count(*)::int from app.subscriptions where org_id = pg_temp.id('org_b') and subscription_state <> 'canceled'), 0,
  'the subscription ends at once');
select is(private.org_read_only_reason(pg_temp.id('org_b')), 'deletion', 'the org is read-only while it waits');
select is((select count(*)::int from app.notifications where kind = 'organization.deletion_requested' and recipient_person_id = pg_temp.id('xavier')),
  1, 'every Owner is told');
select pg_temp.as_user('xavier');
select throws_like($$insert into app.teams (org_id, name) values ((select id from world where key = 'org_b'), 'Late Crew')$$,
  'org_read_only: This organization is waiting to be deleted%', 'writes are refused with the reason');
select pg_temp.as_stepped_up('xavier');
select throws_like($$select app.request_org_deletion((select id from world where key = 'org_b'), 'Harbor Lights Productions', 'Again.')$$,
  'org_deletion_pending:%', 'one deletion request at a time');
select pg_temp.as_user('xavier');
select is(app.recover_org_deletion(pg_temp.id('org_b')), pg_temp.id('del_b'), 'the Owner recovers the org within the window');
select pg_temp.as_platform();
select is(private.org_read_only_reason(pg_temp.id('org_b')), null, 'writes work again');
select pg_temp.as_user('xavier');
select results_eq($$select plan_code, subscription_state::text from app.subscriptions where org_id = (select id from world where key = 'org_b') and subscription_state <> 'canceled'$$,
  $$values ('access'::text, 'active'::text)$$, 'and the org restarts on the Access plan');
select throws_like($$select app.recover_org_deletion((select id from world where key = 'org_b'))$$,
  'org_deletion_not_pending:%', 'a recovered org has nothing to recover');

-- Legal hold ------------------------------------------------------------------------------------------------------
insert into app.legal_holds (org_id, matter) values (pg_temp.id('org_b'), 'Harbor insurance claim.');
select pg_temp.as_stepped_up('xavier');
select throws_like($$select app.request_org_deletion((select id from world where key = 'org_b'), 'Harbor Lights Productions', 'Closing.')$$,
  'org_deletion_legal_hold:%', 'an org under a legal hold cannot ask for deletion');
select pg_temp.as_platform();
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_b');

-- Due: the certificate --------------------------------------------------------------------------------------------
select pg_temp.as_stepped_up('xavier');
select app.request_org_deletion(pg_temp.id('org_b'), 'Harbor Lights Productions', 'We are closing down for good.');
select pg_temp.as_platform();
select is(private.schedule_deletions(now() + interval '6 days'), 0, 'nothing is due inside the window');
select is(private.schedule_deletions(now() + interval '7 days 1 hour'), 1, 'after the window the job writes a certificate');
insert into world select 'cert_b', id from app.deletion_certificates where deleted_org_id = pg_temp.id('org_b');
select results_eq($$select basis, org_name, org_slug, owner_person_id, owner_email, locale from app.deletion_certificates where id = (select id from world where key = 'cert_b')$$,
  $$values ('deletion_request'::text, 'Harbor Lights Productions'::text, 'harbor-lights'::text, (select id from world where key = 'xavier'), 'xavier@harborlights.test'::text, 'en-US'::text)$$,
  'the certificate names the org and the Owner it goes to');
select is(private.schedule_deletions(now() + interval '8 days'), 0, 'an org gets one certificate');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.deletion_certificates), 0, 'nobody else reads the certificate');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.deletion_certificates), 1, 'the former Owner reads it');

-- Storage objects, through the Storage API ---------------------------------------------------------------------------
select pg_temp.as_platform();
insert into storage.objects (bucket_id, name, owner_id) values ('org-brand', pg_temp.id('org_b') || '/logo.png', null);
select is((select count(*)::int from app.claim_deletion_certificates('worker-test', 5)), 1, 'the worker claims the certificate');
select is((select name from app.deletion_storage_objects(pg_temp.id('cert_b'))), pg_temp.id('org_b') || '/logo.png',
  'the worker lists the org''s storage objects');
select is(app.record_deletion_storage_cleared(pg_temp.id('cert_b'), 0), false, 'storage is not clear while an object remains');
select is(private.run_org_purges(5), 0, 'and no row is purged before the storage is clear');
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'org-brand' and name = pg_temp.id('org_b') || '/logo.png';
reset storage.allow_delete_query;
select is(app.record_deletion_storage_cleared(pg_temp.id('cert_b'), 1), true, 'once the Storage API deleted them, the storage is clear');

-- The purge ---------------------------------------------------------------------------------------------------------
create temporary table counts_before as
select (select count(*) from app.audit_events where org_id = pg_temp.id('org_a')) as audit_a,
       (select count(*) from app.memberships where org_id = pg_temp.id('org_a')) as members_a;
select is(private.run_org_purges(5), 1, 'the lifecycle job purges the org');
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_b')), 0, 'the org row is gone');
select is((select count(*)::int from app.memberships where org_id = pg_temp.id('org_b')), 0, 'its memberships are gone');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_b')), 0, 'its audit trail went with it');
select is((select count(*)::int from app.subscription_state_transitions where org_id = pg_temp.id('org_b')), 0, 'and its ledgers');
select ok(exists (select 1 from app.people where id = pg_temp.id('xavier')) and exists (select 1 from app.people where id = pg_temp.id('mia')),
  'people outlive the org: their accounts are their own');
select ok((select audit_a from counts_before) = (select count(*) from app.audit_events where org_id = pg_temp.id('org_a'))
  and (select members_a from counts_before) = (select count(*) from app.memberships where org_id = pg_temp.id('org_a')),
  'other orgs keep every row');
select ok((select purged_at is not null and rows_purged > 0 and tables_purged > 0 and storage_objects_deleted = 1
  from app.deletion_certificates where id = pg_temp.id('cert_b')), 'the certificate records what was deleted');
select is(private.in_tenant_purge(pg_temp.id('org_b')), false, 'the purge mark ends with the purge');

-- Issue and deliver ---------------------------------------------------------------------------------------------------
select lives_ok($$select app.record_deletion_certificate_issued((select id from world where key = 'cert_b'), 'cert.pdf', repeat('a', 64))$$,
  'the worker records the stored PDF');
select lives_ok($$select app.record_deletion_certificate_delivered((select id from world where key = 'cert_b'), 'msg-1')$$,
  'and the email to the former Owner');
select is((select count(*)::int from app.claim_deletion_certificates('worker-test', 5)), 0, 'a delivered certificate has no more work');

-- Blocked: another org references this one --------------------------------------------------------------------------
insert into app.record_grants (target_kind, target_id, capability_code, grantee_org_id, valid_to, reason)
values ('organization', pg_temp.id('org_a'), 'org.settings.read', pg_temp.id('org_c'), now() + interval '1 day', 'Joint season planning.');
insert into world select 'cert_c', private.write_deletion_certificate(pg_temp.id('org_c'), 'cancellation', now(), now(), null);
update app.deletion_certificates set storage_cleared_at = now() where id = pg_temp.id('cert_c');
select is(private.purge_organization(pg_temp.id('cert_c')), null, 'a purge that would reach another org''s rows stops');
select ok((select blocked_reason like '%app.record_grants%' from app.deletion_certificates where id = pg_temp.id('cert_c')),
  'and records why, for the platform to resolve');
select is((select count(*)::int from app.organizations where id = pg_temp.id('org_c')), 1, 'nothing of that org was deleted');

-- Who may run it -------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.purge_organization(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.purge_organization(uuid)', 'execute'),
  'only the database owner runs the purge, from the lifecycle job');
select ok(not has_function_privilege('authenticated', 'app.claim_deletion_certificates(text, integer)', 'execute')
  and has_function_privilege('service_role', 'app.claim_deletion_certificates(text, integer)', 'execute'),
  'the worker API is for the service role only');

select * from finish();
rollback;
