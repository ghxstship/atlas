-- pgTAP: feed posts for a canon department (A80, RRR-125, finding A65-021, Section 4.9 Feed): who is in the
-- department (an Active role assignment in one of its roles, or a Department group tagged with it), reading,
-- notifications and acknowledgments, and the audiences that take no department.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(14);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- frank holds a Production (5000) role on prj_a; erin is in the Production department group; dave is in neither.
select pg_temp.as_platform();
set local session_replication_role = replica;
insert into app.role_assignments (org_id, project_id, role_code, person_id, staffing_basis, assignment_state)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.50.01', pg_temp.id('frank'), 'Declared', 'Active');
set local session_replication_role = origin;
insert into k values ('dept_group', gen_random_uuid());
insert into app.groups (id, org_id, name, group_kind, department_code)
values ((select id from k where key = 'dept_group'), pg_temp.id('org_a'), 'Production crew', 'Department', '5000');
insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'dept_group'), pg_temp.id('erin@org_a'));

select set_eq($$select private.department_membership_ids(pg_temp.id('org_a'), '5000')$$,
  $$values (pg_temp.id('frank@org_a')), (pg_temp.id('erin@org_a'))$$,
  'a department reaches holders of its roles and members of its department groups');
select throws_ok($$insert into app.groups (org_id, name, group_kind, department_code) values (pg_temp.id('org_a'), 'Night crew', 'Crew', '5000')$$,
  '23514', null, 'only a Department group names a department');

-- Posting to a department --------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Production meeting at 14:00.', p_audience_kind => 'Department')$$,
  'XR001', null, 'a Department audience names its department');
select throws_ok($$select app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'x', p_audience_kind => 'Department', p_department_code => '1234')$$,
  'XR001', null, 'and only a canon department');
select lives_ok($$insert into k select 'post', app.create_feed_post(pg_temp.id('org_a'), 'Announcement', 'Production meeting at 14:00.',
  'Production meeting', p_audience_kind => 'Department', p_department_code => '5000', p_requires_acknowledgment => true)$$,
  'a manager posts an announcement to the Production department');

select pg_temp.as_user('frank');
select is((select count(*)::integer from app.feed_posts where id = (select id from k where key = 'post')), 1, 'a role holder in the department reads it');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.feed_posts where id = (select id from k where key = 'post')), 1, 'a department group member reads it');
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.feed_posts where id = (select id from k where key = 'post')), 0, 'someone outside the department does not');
select throws_ok($$select app.acknowledge_feed_post((select id from k where key = 'post'))$$, '42501', null,
  'nor acknowledges it');

select pg_temp.as_platform();
select set_eq($$select n.recipient_person_id from app.notifications n where n.kind = 'announcement.posted' and n.subject_id = (select id from k where key = 'post')$$,
  $$values (pg_temp.id('frank')), (pg_temp.id('erin'))$$, 'publishing notifies the department''s members only');

select pg_temp.as_user('erin');
select lives_ok($$select app.acknowledge_feed_post((select id from k where key = 'post'))$$, 'a department member acknowledges it');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.feed_acknowledgment_status((select id from k where key = 'post'))), 2,
  'acknowledgment tracking lists the department''s members');

-- Surveys and events take no department ---------------------------------------------------------------------------------
select throws_ok($$select app.create_survey(pg_temp.id('org_a'), 'Pulse', '[{"prompt": "How was it?", "kind": "Scale", "scale_max": 5}]'::jsonb,
  p_audience_kind => 'Department')$$, 'XR001', null, 'a survey cannot target a department');
select pg_temp.as_platform();
select throws_ok($$update app.feed_posts set department_code = '6000' where id = (select id from k where key = 'post')$$, 'XR001', null,
  'a post keeps its department');

select * from finish();
rollback;
