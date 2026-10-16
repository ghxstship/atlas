-- Security finding A22-003 (regression): only a thread's opener, a participant or an org member
-- manager may resolve or trash it; a Viewer who can read the subject cannot.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(6);

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
  'a Viewer cannot resolve a thread someone else opened');
select isnt(pg_temp.touched(format($$update app.comment_threads set deleted_at = now() where id = %L$$, pg_temp.id('thread_a'))), '1',
  'a Viewer cannot move a thread someone else opened to Trash');

select pg_temp.as_platform();
select is((select deleted_at is null and resolved_at is null from app.comment_threads where id = pg_temp.id('thread_a')), true,
  'the Owner''s thread is still open and visible');

select pg_temp.as_user('alice');
select is(pg_temp.touched(format($$update app.comment_threads set resolved_at = now() where id = %L$$, pg_temp.id('thread_a'))), '1',
  'the opener resolves the thread');
select pg_temp.as_user('gina');
select is((select resolved_by is not null from app.comment_threads where id = pg_temp.id('thread_a')), true,
  'the Viewer still reads the resolved thread');

select * from finish();
rollback;
