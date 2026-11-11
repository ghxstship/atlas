-- pgTAP: migration 6526 (B10, G-132), the pool_invitations import target. The target and its fields, the job's two columns,
-- the strong key on pending rows inside the pool, the creator's rate reach, fuzzy matching against pending invitations and
-- members, and undo keeping what was answered. Nothing writes a person or a profile.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.refusal(p_sql text) returns text
language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return null;
exception when sqlstate 'XR001' then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;
grant execute on function pg_temp.refusal(text) to public;

create function pg_temp.path(p_person text) returns text
language sql as $$ select pg_temp.id(p_person) || '/' || gen_random_uuid() || '.csv' $$;
grant execute on function pg_temp.path(text) to public;

select pg_temp.new_user('rae', 'rae@freelance.test', 'Rae Sandoval');
select pg_temp.new_user('ned', 'ned@freelance.test', 'Ned Vargas');

select pg_temp.as_user('alice');
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Stagehands', 'Talent') returning id) insert into world select 'pool', id from p;
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Audio Vendors', 'Vendor') returning id) insert into world select 'vpool', id from p;
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Second', 'Talent') returning id) insert into world select 'pool2', id from p;
insert into world select 'inv_pending', app.invite_to_talent_pool(pg_temp.id('pool'), 'pending@freelance.test', 'Jordan Pike');
insert into world select 'inv_gone', app.invite_to_talent_pool(pg_temp.id('pool'), 'gone@freelance.test');
select app.revoke_pool_invitation(pg_temp.id('inv_gone'));
insert into app.pool_members (talent_pool_id, person_id, standing) values (pg_temp.id('pool'), pg_temp.id('rae'), 'Approved');

-- The target ---------------------------------------------------------------------------------------------------------------------
select results_eq($$select destination, write_capability from app.import_targets where code = 'pool_invitations'$$,
  $$values (null::text, 'opportunities.pool.write'::text)$$, 'the target appears with destination NULL and the pool write capability');

-- The job's two columns -------------------------------------------------------------------------------------------------------------
select is(pg_temp.refusal(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, talent_pool_id) values ('%s', 'venues', 'CSV', 'a.csv', pg_temp.path('alice'), '%s')$$, pg_temp.id('org_a'), pg_temp.id('pool'))),
  'import_pool_unexpected', 'a pool only goes with this target');
select is(pg_temp.refusal(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, talent_pool_id) values ('%s', 'pool_invitations', 'CSV', 'a.csv', pg_temp.path('alice'), '%s')$$, pg_temp.id('org_a'), pg_temp.id('vpool'))),
  'import_pool_unknown', 'and only a live Talent pool of the org');
with j as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, talent_pool_id, number_format)
  values (pg_temp.id('org_a'), 'pool_invitations', 'CSV', 'crew.csv', pg_temp.path('alice'), pg_temp.id('pool'), 'dot-comma') returning id) insert into world select 'job', id from j;
select is(pg_temp.refusal(format($$update app.import_jobs set number_format = 'comma-dot' where id = '%s'$$, pg_temp.id('job'))), 'import_job_immutable', 'the number format cannot change');
select is(pg_temp.refusal(format($$update app.import_jobs set talent_pool_id = '%s' where id = '%s'$$, pg_temp.id('pool2'), pg_temp.id('job'))), 'import_job_immutable', 'nor the pool');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, number_format) values ('%s', 'pool_invitations', 'CSV', 'a.csv', pg_temp.path('alice'), 'hash-dot')$$, pg_temp.id('org_a')),
  '23514', null, 'a number format is one of the four');

-- Strong key ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(app.import_strong_key_match(pg_temp.id('job'), jsonb_build_object('email', ' PENDING@freelance.test ', 'talent_pool_id', pg_temp.id('pool'))), pg_temp.id('inv_pending'), 'email matches inside the pool');
select is(app.import_strong_key_match(pg_temp.id('job'), jsonb_build_object('email', 'pending@freelance.test', 'talent_pool_id', pg_temp.id('pool2'))), null::uuid, 'and not in another pool');
select is(app.import_strong_key_match(pg_temp.id('job'), jsonb_build_object('email', 'gone@freelance.test', 'talent_pool_id', pg_temp.id('pool'))), null::uuid, 'pending rows only');
update app.talent_pool_invitations set expires_at = now() - interval '1 day' where id = pg_temp.id('inv_pending');
select is(app.import_strong_key_match(pg_temp.id('job'), jsonb_build_object('email', 'pending@freelance.test', 'talent_pool_id', pg_temp.id('pool'))), pg_temp.id('inv_pending'), 'an expired one still matches, so the worker reissues it');

-- The creator's rate reach ---------------------------------------------------------------------------------------------------------------
select is(app.import_job_can_write_rates(pg_temp.id('job')), true, 'an owner who created the job may write rates');
select pg_temp.as_user('carol');
with j as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path) values (pg_temp.id('org_a'), 'pool_invitations', 'CSV', 'crew2.csv', pg_temp.path('carol')) returning id) insert into world select 'job_carol', id from j;
select throws_ok($$select app.import_job_can_write_rates((select id from world where key = 'job'))$$, '42501', null, 'the check is service_role only');
select pg_temp.as_platform();
select is(app.import_job_can_write_rates(pg_temp.id('job_carol')), false, 'a creator without org-wide payroll may not');

-- Fuzzy matching --------------------------------------------------------------------------------------------------------------------------
update app.import_jobs set mapping_confirmed_at = now() where id = pg_temp.id('job');
insert into world select 'r_inv', app.record_import_row(pg_temp.id('job'), 'Crew', 2, 'Valid', null, 'Pike, Jordan');
select is((select m.candidate_id from app.merge_reviews m where m.import_row_result_id = pg_temp.id('r_inv')), pg_temp.id('inv_pending'), 'a near name finds a pending invitation');
select is((select m.decision::text from app.merge_reviews m where m.import_row_result_id = pg_temp.id('r_inv')), 'Pending', 'as a Pending merge review');
insert into world select 'r_mem', app.record_import_row(pg_temp.id('job'), 'Crew', 3, 'Valid', null, 'Sandoval, Rae');
select is((select m.candidate_table from app.merge_reviews m where m.import_row_result_id = pg_temp.id('r_mem')), 'app.pool_members', 'and a pool member');
select ok((select m.similarity >= 0.85 from app.merge_reviews m where m.import_row_result_id = pg_temp.id('r_mem')), 'at 0.85 or above');

-- Committing writes no people, and undo keeps what was answered ---------------------------------------------------------------------------
select pg_temp.as_user('alice');
with j as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, talent_pool_id)
  values (pg_temp.id('org_a'), 'pool_invitations', 'CSV', 'commit.csv', pg_temp.path('alice'), pg_temp.id('pool')) returning id) insert into world select 'job2', id from j;
insert into world select 'inv_a', app.invite_to_talent_pool(pg_temp.id('pool'), 'a@freelance.test');
insert into world select 'inv_claim', app.invite_to_talent_pool(pg_temp.id('pool'), 'ned@freelance.test');
select pg_temp.as_platform();
create temporary table counts as select (select count(*) from app.people) as people, (select count(*) from app.person_profiles) as profiles;
update app.import_jobs set import_status = 'Validated', mapping_confirmed_at = now() where id = pg_temp.id('job2');
insert into world select 'r_a', app.record_import_row(pg_temp.id('job2'), 'Crew', 2, 'Valid');
insert into world select 'r_claim', app.record_import_row(pg_temp.id('job2'), 'Crew', 3, 'Valid');
select pg_temp.as_user('alice');
insert into world select 'batch', app.request_import_commit(pg_temp.id('job2'));
select pg_temp.as_platform();
select app.commit_import_write(pg_temp.id('r_a'), pg_temp.id('batch'), pg_temp.id('inv_a'), 'Created');
select app.commit_import_write(pg_temp.id('r_claim'), pg_temp.id('batch'), pg_temp.id('inv_claim'), 'Created');
select app.finish_import_batch(pg_temp.id('batch'));
update app.import_batches set committed_at = now() - interval '1 hour' where id = pg_temp.id('batch');
alter table app.talent_pool_invitations disable trigger t90_stamp_audit_columns;
update app.talent_pool_invitations set updated_at = now() - interval '2 hours' where id in (pg_temp.id('inv_a'), pg_temp.id('inv_claim'));
alter table app.talent_pool_invitations enable trigger t90_stamp_audit_columns;
select is((select count(*) from app.people), (select people from counts), 'committing creates no people');
select is((select count(*) from app.person_profiles), (select profiles from counts), 'and no profiles');
select pg_temp.as_user('ned');
select app.respond_party_invitation('pool', pg_temp.id('inv_claim'), true);
select pg_temp.as_user('alice');
select results_eq(format($$select reverted, kept from app.undo_import_batch('%s', 'Wrong file.')$$, pg_temp.id('batch')), $$values (1, 1)$$, 'undo reverts the unanswered invitation and keeps the claimed one');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.talent_pool_invitations where id = pg_temp.id('inv_a')), 'the unanswered invitation is soft-deleted');
select ok((select deleted_at is null from app.talent_pool_invitations where id = pg_temp.id('inv_claim')), 'the claimed one stays');
select is((select undo_reason from app.import_row_results where id = pg_temp.id('r_claim')), 'The row was edited after the import.', 'listed with a reason');

select * from finish();
rollback;
