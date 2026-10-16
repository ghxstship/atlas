-- A22-003 (Medium): app.comment_threads_update lets anyone who can read a thread's subject update
-- the thread. A Viewer, the read-only band, can resolve or move to Trash a thread another person
-- opened, which hides the whole discussion from every member. private.guard_comment_thread pins the
-- subject and stamps resolution but never checks who is acting, and deleted_at is not guarded.
--
-- Regression test from the attacker's side: fixed in migration 0937 (RRR-41). This file failed on
-- main d36918a and must keep passing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(4);

-- Alice (Owner) adds Gina, a Viewer of the org, to the project as a read-only stakeholder, and
-- opens a thread on the project.
select pg_temp.as_user('alice');
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Coordinator');
insert into app.comment_threads (subject_table, subject_id) values ('app.projects', pg_temp.id('prj_a'));
select pg_temp.as_platform();
insert into world select 'thread_a', t.id from app.comment_threads t
where t.subject_table = 'app.projects' and t.subject_id = pg_temp.id('prj_a') order by t.created_at desc limit 1;

create function pg_temp.touched(p_sql text) returns text
language plpgsql as $$
declare
  v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return v_rows::text;
exception when others then
  return sqlstate;
end $$;

-- Gina keeps the Viewer band: she reads the project but writes nothing in it.
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.comment_threads where id = pg_temp.id('thread_a')), 1,
  'control: the Viewer can read the thread');

select isnt(pg_temp.touched(format($$update app.comment_threads set resolved_at = now() where id = %L$$, pg_temp.id('thread_a'))), '1',
  'A22-003: a Viewer cannot resolve a thread someone else opened');
select isnt(pg_temp.touched(format($$update app.comment_threads set deleted_at = now() where id = %L$$, pg_temp.id('thread_a'))), '1',
  'A22-003: a Viewer cannot move a thread someone else opened to Trash');

select pg_temp.as_platform();
select is((select deleted_at is null and resolved_at is null from app.comment_threads where id = pg_temp.id('thread_a')), true,
  'A22-003: the Owner''s thread is still open and visible');

select * from finish();
rollback;
