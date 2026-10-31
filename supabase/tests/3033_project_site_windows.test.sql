-- pgTAP: bump-in and bump-out windows (3033, B14 G-262; ADR 0153 C1). The windows come from the project's Load In and
-- Load Out days at local midnight and are never stored; the site window takes them before the Build and Strike records
-- and the show dates, and R7a's hire warnings follow it; the warnings view lists a load-in after the first show day, a
-- load-out before the last, overlapping and over-long windows and bump days without show dates, and refuses nothing; a
-- window across the end of daylight saving keeps local midnights; a reader of neither purchase orders nor the schedule
-- gets no windows.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

-- Readers have no usage on schema private, so the helpers are read under the reader's claims as the owner.
create function pg_temp.windows(p_key text, p_project text) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.claims(p_key);
  select row(w.bump_in, w.bump_out)::text into v from private.project_bump_windows(pg_temp.id(p_project)) w;
  perform pg_temp.as_user(p_key);
  return v;
end $$;
create function pg_temp.site_window(p_key text, p_project text) returns tstzrange
language plpgsql as $$
declare
  v tstzrange;
begin
  perform pg_temp.claims(p_key);
  v := private.project_site_window(pg_temp.id(p_project));
  perform pg_temp.as_user(p_key);
  return v;
end $$;
create function pg_temp.warnings(p_project text) returns text
language sql as $$
  select coalesce(string_agg(w.warning || coalesce('@' || w.day_on, ''), ', ' order by w.warning, w.day_on), '-')
  from app.project_site_window_warnings w where w.project_id = pg_temp.id(p_project)
$$;
create function pg_temp.lay(p_project text, p_from date, p_to date, p_type app.project_day_type, p_sort smallint default 1)
returns void
language sql as $$
  insert into app.project_days (project_id, day_on, day_type, sort_order)
  select pg_temp.id(p_project), d::date, p_type, p_sort from generate_series(p_from, p_to, interval '1 day') d
$$;

select has_function('private', 'project_bump_windows', array['uuid'], 'private.project_bump_windows exists');
select hasnt_column('app', 'projects', 'bump_in_window', 'no bump window is stored on projects (ADR 0143 decision 1)');

-- Fixture: NWL (America/New_York) shows on 15 and 16 June 2027, loads in from the 12th and out on the 17th and 18th, and
-- has a Build record from the 10th.
select pg_temp.as_user('carol');
update app.projects set starts_on = '2027-06-15', ends_on = '2027-06-16' where id = pg_temp.id('prj_a');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, ends_at)
values (pg_temp.id('prj_a'), 'Build', 'Build the main stage', 'Y', 'Declared', '2027-06-10 12:00+00', '2027-06-10 20:00+00');
select is(pg_temp.site_window('carol', 'prj_a'), tstzrange('2027-06-10 12:00+00', '2027-06-17 04:00+00', '[)'),
  'without bump days the window is 2683''s: the Build start to the day after the last show day');
select pg_temp.lay('prj_a', '2027-06-12', '2027-06-14', 'Load In');
select pg_temp.lay('prj_a', '2027-06-15', '2027-06-16', 'Show');
select pg_temp.lay('prj_a', '2027-06-17', '2027-06-18', 'Load Out');

select is(pg_temp.windows('carol', 'prj_a'),
  row(tstzrange('2027-06-12 04:00+00', '2027-06-15 04:00+00', '[)'), tstzrange('2027-06-17 04:00+00', '2027-06-19 04:00+00', '[)'))::text,
  'bump-in and bump-out run between local midnights of the Load In and Load Out days');
select is(pg_temp.site_window('carol', 'prj_a'), tstzrange('2027-06-12 04:00+00', '2027-06-19 04:00+00', '[)'),
  'the site window is [06-12 00:00, 06-19 00:00) local, even with a Build record earlier');
select is((select row(bump_in, bump_out, site_window)::text from app.project_site_windows where project_id = pg_temp.id('prj_a')),
  row(tstzrange('2027-06-12 04:00+00', '2027-06-15 04:00+00', '[)'), tstzrange('2027-06-17 04:00+00', '2027-06-19 04:00+00', '[)'),
      tstzrange('2027-06-12 04:00+00', '2027-06-19 04:00+00', '[)'))::text,
  'app.project_site_windows gives the apps the same windows');
select is((select string_agg(w, ', ' order by w) from app.hire_window_warnings(pg_temp.id('prj_a'),
            '2027-06-13 12:00+00', '2027-06-19 04:00+00') w), 'Delivery After Load In',
  'a hire starting on the 13th is delivered after load-in begins');
select is(pg_temp.warnings('prj_a'), '-', 'days that fit the show dates raise no warning');

-- The warnings, never refusals.
select lives_ok($$select pg_temp.lay('prj_a', '2027-06-16', '2027-06-16', 'Load In', 2::smallint)$$,
  'a load-in on a show day, as a tour moves on, is saved');
select is(pg_temp.warnings('prj_a'), 'project_bump_in_after_show@2027-06-16',
  'a Load In day after the first show day is listed; the windows still meet without overlapping');
update app.project_days set deleted_at = now() where project_id = pg_temp.id('prj_a') and day_on = '2027-06-16' and day_type = 'Load In';
select pg_temp.lay('prj_a', '2027-06-14', '2027-06-14', 'Load Out', 2::smallint);
select is(pg_temp.warnings('prj_a'), 'project_bump_out_before_show@2027-06-14, project_bump_windows_overlap',
  'a Load Out day before the last show day is listed, and the windows now overlap');
update app.project_days set deleted_at = now() where project_id = pg_temp.id('prj_a') and day_on = '2027-06-14' and day_type = 'Load Out';
select pg_temp.lay('prj_a', '2027-04-01', '2027-04-01', 'Load In');
select is(pg_temp.warnings('prj_a'), 'project_bump_window_length', 'a bump-in longer than 60 days is listed');
update app.project_days set deleted_at = now() where project_id = pg_temp.id('prj_a') and day_on = '2027-04-01';
update app.projects set ends_on = null where id = pg_temp.id('prj_a');
select is(pg_temp.warnings('prj_a'), 'project_bump_window_dates', 'bump days without both show dates are listed');

-- Daylight saving ends on 7 November 2027 in New York: the bump-in still runs between local midnights.
select pg_temp.lay('prj_a2', '2027-11-06', '2027-11-07', 'Load In');
select is(pg_temp.windows('carol', 'prj_a2'),
  row(tstzrange('2027-11-06 04:00+00', '2027-11-08 05:00+00', '[)'), null::tstzrange)::text,
  'a window across the end of daylight saving runs from 00:00 EDT to 00:00 EST');

-- Readers.
select pg_temp.as_platform();
insert into app.roles (org_id, code, name, band) values (pg_temp.id('org_a'), 'gala_watcher', 'Gala Watcher', 5);
insert into app.role_capabilities (role_id, capability_code, reach)
  select r.id, c.code, 'organization' from app.roles r
  cross join (values ('projects.project.read'), ('projects.members.manage')) c (code)
  where r.code = 'gala_watcher';
delete from app.membership_roles where membership_id = pg_temp.id('gina@org_a');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('gina@org_a'), r.id from app.roles r where r.code = 'gala_watcher';
select is(pg_temp.windows('gina', 'prj_a2'), row(null::tstzrange, null::tstzrange)::text,
  'a reader of neither purchase orders nor the schedule gets no windows');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.project_site_window_warnings', 'select')
  and not has_table_privilege('xos_backup', 'app.project_site_windows', 'select'), 'xos_backup cannot select either view');

select * from finish();
rollback;
