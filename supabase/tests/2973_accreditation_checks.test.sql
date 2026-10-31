-- pgTAP: migration 2973 (B8, G-147), one accreditation list. A second live Access credential of the same category and
-- holder for an overlapping window is refused, on insert and on an update that widens the window or brings a deleted
-- or revoked one back; Parking is exempt; revoke then issue works; a holder booked on another project (credential or
-- engagement) is flagged; the other project's key shows only to someone who can read it; credential_review(ids) gives the
-- checks the Issued page shows; the issue check lists them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

select pg_temp.as_user('carol');
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id) insert into world select 'cat', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'PROD', 'Production') returning id) insert into world select 'cat_prod', id from x;
with x as (insert into app.credential_categories (project_id, code, name, category_kind) values (pg_temp.id('prj_a'), 'PARK', 'Parking', 'Parking') returning id) insert into world select 'cat_park', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'GALA', 'Gala Crew') returning id) insert into world select 'cat_a2', id from x;

-- The duplicate rule ------------------------------------------------------------------------------------------------------------
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values (pg_temp.id('cat'), pg_temp.id('frank'), '2027-06-01 08:00+00', '2027-06-05 08:00+00') returning id) insert into world select 'c1', id from x;
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values ((select id from world where key = 'cat'), (select id from world where key = 'frank'), '2027-06-04 08:00+00', '2027-06-08 08:00+00')$$,
  'XR001', 'credential_duplicate: This person already holds a live credential of this category for an overlapping window. Revoke the earlier credential first, or change the window.',
  'a second overlapping Access credential of the same category is refused');
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values (pg_temp.id('cat'), pg_temp.id('frank'), '2027-06-05 08:00+00', '2027-06-08 08:00+00') returning id) insert into world select 'c2', id from x;
select ok(pg_temp.id('c2') is not null, 'a window that starts as the first ends does not overlap');
select throws_ok($$update app.credentials set valid_to = '2027-06-06 08:00+00' where id = (select id from world where key = 'c1')$$,
  'XR001', null, 'an update of valid_to that creates an overlap is refused');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values ((select id from world where key = 'cat_prod'), (select id from world where key = 'frank'), '2027-06-01 08:00+00', '2027-06-05 08:00+00')$$,
  'another category in the same window is allowed');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_park'), (select id from world where key = 'dave'))$$,
  'a parking pass is issued');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat_park'), (select id from world where key = 'dave'))$$,
  'and a second one for another vehicle: Parking is exempt');
update app.credentials set revoked_at = now() where id = pg_temp.id('c2');
select ok((select revoked_at is not null from app.credentials where id = pg_temp.id('c2')), 'moving a credential to revoked is always allowed');
select lives_ok($$insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values ((select id from world where key = 'cat'), (select id from world where key = 'frank'), '2027-06-06 08:00+00', '2027-06-09 08:00+00')$$,
  'after revoking the earlier credential, a new one for its window is issued');
select pg_temp.as_platform();
update app.credentials set deleted_at = now() where id = pg_temp.id('c1');
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values (pg_temp.id('cat'), pg_temp.id('frank'), '2027-06-01 08:00+00', '2027-06-03 08:00+00') returning id) insert into world select 'c3', id from x;
select throws_ok($$update app.credentials set deleted_at = null where id = (select id from world where key = 'c1')$$,
  'XR001', null, 'clearing deleted_at by hand cannot bring a duplicate back');

-- Booked elsewhere ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values (pg_temp.id('cat_a2'), pg_temp.id('frank'), '2027-06-02 08:00+00', '2027-06-03 08:00+00') returning id) insert into world select 'c_a2', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values (pg_temp.id('cat_a2'), pg_temp.id('ivy'), '2027-05-31 08:00+00', '2027-06-02 08:00+00') returning id) insert into world select 'c_ivy', id from x;
with x as (insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to)
  values (pg_temp.id('cat'), pg_temp.id('erin'), '2027-06-10 08:00+00', '2027-06-12 08:00+00') returning id) insert into world select 'c_erin', id from x;
select is((select booked_elsewhere from app.credential_review(array[pg_temp.id('c3')])), true,
  'frank''s NWL badge is booked elsewhere: a live overlapping badge on NWX');
select is((select booked_elsewhere from app.credential_review(array[pg_temp.id('c_ivy')])), true,
  'ivy''s NWX badge is booked elsewhere: a live engagement on NWL the same days');
select is((select booked_elsewhere from app.credential_review(array[pg_temp.id('c_erin')])), false, 'erin is booked nowhere else');
select is((select string_agg(coalesce(project_key, '-') || ':' || kind, ',') from app.credential_bookings_elsewhere(pg_temp.id('c_ivy'))),
  'NWL:Engagement', 'carol sees the engagement''s project');
select is((select string_agg(coalesce(project_key, '-') || ':' || kind, ',') from app.credential_bookings_elsewhere(pg_temp.id('c3'))),
  'NWX:Credential', 'and the other badge''s project');
select pg_temp.as_user('erin');
select is((select string_agg(coalesce(project_key, '-') || ':' || kind || ':' || (project_id is null)::text, ',') from app.credential_bookings_elsewhere(pg_temp.id('c3'))),
  '-:Credential:true', 'a Collaborator who cannot read NWX sees only that the holder is booked on another production');
select throws_ok($$select * from app.credential_bookings_elsewhere((select id from world where key = 'c_ivy'))$$,
  '42501', null, 'and cannot ask about a credential of a project they cannot read');
select pg_temp.as_platform();
select ok(not has_function_privilege('authenticated', 'private.holder_booked_elsewhere(uuid, uuid, uuid, timestamptz, timestamptz, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.same_name_holders(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.holder_is_member(uuid, uuid, uuid)', 'execute'),
  'the review helpers are internal: only the definer functions call them');

-- The review ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select holder_source from app.credential_review(array[pg_temp.id('c3')])), 'Member', 'a member''s badge is Member');
select is((select holder_source from app.credential_review(array[pg_temp.id('c_ivy')])), 'Direct', 'a freelancer''s badge issued by hand is Direct');
select is((select other_badges_on_project from app.credential_review(array[pg_temp.id('c3')])), 1, 'frank holds one other badge on NWL');
select is((select duplicate_live from app.credential_review(array[pg_temp.id('c3')])), false, 'and no duplicate');
select pg_temp.as_platform();
update app.people set full_name = 'Frank Adeyemi' where id = pg_temp.id('erin');
select pg_temp.as_user('carol');
select is((select same_name_on_project from app.credential_review(array[pg_temp.id('c3')])), 1, 'another holder with the same name on the project is counted');
select is((select missing_requirements from app.credential_review(array[pg_temp.id('c3')])), 0, 'no requirement is missing');
select pg_temp.as_platform();
set local session_replication_role = replica;
insert into app.credentials (id, org_id, project_id, credential_category_id, holder_person_id, credential_number, valid_from, valid_to)
values ('01920000-0000-7000-8973-000000000001', pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('cat'), pg_temp.id('frank'), 'CR-OLD001',
        '2027-06-02 08:00+00', '2027-06-04 08:00+00');
set local session_replication_role = origin;
select pg_temp.as_user('carol');
select is((select duplicate_live from app.credential_review(array[pg_temp.id('c3')])), true,
  'a duplicate from before 2973 shows on the review');
select is((select string_agg(check_code || ':' || blocking::text, ',' order by check_code)
           from app.credential_issue_check(pg_temp.id('cat'), pg_temp.id('frank'), '2027-06-02 09:00+00', '2027-06-02 10:00+00')),
  'booked_elsewhere:false,duplicate:true,duplicate:true,other_badge_on_project:false,same_name_on_project:false',
  'the issue check lists the duplicates as blocking and the rest as warnings');
select is((select project_key from app.credential_issue_check(pg_temp.id('cat'), pg_temp.id('frank'), '2027-06-02 09:00+00', '2027-06-02 10:00+00') where check_code = 'booked_elsewhere'),
  'NWX', 'with the other project''s key for a reader of it');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.credential_review(array[pg_temp.id('c3')])), 1, 'a Viewer reads the review of credentials they can read');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.credential_review(array[pg_temp.id('c3'), pg_temp.id('c_ivy')])), 0, 'another org reads none');
select pg_temp.as_platform();

select * from finish();
rollback;
