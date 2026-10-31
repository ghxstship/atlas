-- pgTAP: copying a past project's setup (3036, B14 G-252; ADR 0153 D4, C10 to C12). NWL is last year's festival and
-- NWX this year's, 28 days later. The preview writes nothing and returns exactly what the commit writes; records,
-- access grid windows, hotel dates, budget lines and advance due dates move 28 days on the wall clock across the start
-- of daylight saving; parents and dependencies are remapped inside the copy; unit prices stay NULL, the copied budget
-- is not a baseline and an Event cost center is cleared; grid rows at another venue, a taken code, a missing category
-- and a taken scope code are skipped with reasons; nothing that is a booking or a party's answer is created. The
-- refusals: a missing capability (42501, before anything is written), another org, the same project, an unknown
-- offset, no part, more than 2000 items and a read-only target. The intake form previews with no target.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(33);

create temporary table pv (part app.project_copy_part, item_kind text, source_id uuid, label text, outcome text, skip_reason text,
  new_on date, new_at timestamptz);
create temporary table cm (like pv);
grant select, insert, delete on pv, cm to public;

-- Every row of setup NWX holds, counted.
create function pg_temp.target_rows(p_project text) returns integer
language sql as $$
  select ((select count(*) from app.records where project_id = pg_temp.id(p_project))
    + (select count(*) from app.scope_nodes where project_id = pg_temp.id(p_project))
    + (select count(*) from app.credential_categories where project_id = pg_temp.id(p_project))
    + (select count(*) from app.access_grid where project_id = pg_temp.id(p_project))
    + (select count(*) from app.accommodation_blocks where project_id = pg_temp.id(p_project))
    + (select count(*) from app.budgets where project_id = pg_temp.id(p_project))
    + (select count(*) from app.advance_packets where project_id = pg_temp.id(p_project))
    + (select count(*) from app.project_days where project_id = pg_temp.id(p_project)))::integer
$$;
create function pg_temp.copy_of(p_part text, p_key text) returns text
language sql as $$ select outcome || coalesce(':' || skip_reason, '') from pv where source_id = pg_temp.id(p_key) $$;

-- Fixture ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('org_a'), 'Northwind Riverside Lot', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'venue_c', id from x;
select pg_temp.as_user('carol');
update app.projects set starts_on = '2027-03-01', ends_on = '2027-03-03' where id = pg_temp.id('prj_a');
update app.projects set starts_on = '2027-03-29', ends_on = '2027-03-31', venue_id = pg_temp.id('venue_a') where id = pg_temp.id('prj_a2');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'BOH', 'Back of House') returning id)
  insert into world select 'z_a', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_c'), 'GATE', 'Riverside Gate') returning id)
  insert into world select 'z_c', id from x;

-- The plan: two tasks (the second the child and successor of the first), a Complete one and an Approval record.
with x as (insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Task', 'Execute', 'Rig the follow spots', 'Y', 'Declared',
    '2027-03-05 23:00+00', '2027-03-06 01:00+00') returning id) insert into world select 't1', id from x;
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, due_at, parent_record_id)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Focus the follow spots', 'Y', 'Declared', '2027-03-06 22:00+00', pg_temp.id('t1'))
  returning id) insert into world select 't2', id from x;
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Book the follow spot operators', 'Y', 'Declared') returning id) insert into world select 't3', id from x;
select app.transition_record(pg_temp.id('t3'), 'Proposed', 'Ready', 'Ready.');
select app.transition_record(pg_temp.id('t3'), 'Ready', 'Active', 'Started.');
select app.transition_record(pg_temp.id('t3'), 'Active', 'Complete', 'Booked.');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Approval', 'Review of the rigging plan', 'Y', 'Declared') returning id) insert into world select 'ap', id from x;
with x as (insert into app.record_dependencies (predecessor_record_id, successor_record_id, dependency_type, lag)
  values (pg_temp.id('t1'), pg_temp.id('t2'), 'Finish to Start', interval '2 hours') returning id) insert into world select 'dep', id from x;
with x as (insert into app.project_days (project_id, day_on, day_type) values (pg_temp.id('prj_a'), '2027-02-28', 'Load In') returning id)
  insert into world select 'day', id from x;

-- Pass categories: AAA is already on NWX; the PRK grid row is at a venue NWX does not use.
insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'AAA', 'All Areas');
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'AAA', 'All Areas') returning id)
  insert into world select 'cat_aaa', id from x;
with x as (insert into app.credential_categories (project_id, code, name, category_kind) values (pg_temp.id('prj_a'), 'PRK', 'Parking', 'Parking') returning id)
  insert into world select 'cat_prk', id from x;
with x as (insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
  values (pg_temp.id('cat_aaa'), pg_temp.id('z_a'), 'ENM-036', '2027-03-01 13:00+00', '2027-03-04 04:00+00') returning id)
  insert into world select 'grid_a', id from x;
with x as (insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
  values (pg_temp.id('cat_prk'), pg_temp.id('z_c'), 'ENM-036', '2027-03-01 13:00+00', '2027-03-04 04:00+00') returning id)
  insert into world select 'grid_c', id from x;

-- Hotels, budgets and advance forms.
with x as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, release_on)
  values (pg_temp.id('prj_a'), 'Crew rooms', '2027-02-28', '2027-03-04', 10, '2027-02-14') returning id) insert into world select 'block', id from x;
select pg_temp.as_user('alice');
with x as (insert into app.cost_centers (org_id, code, name, kind, scope_node_id)
  values (pg_temp.id('org_a'), 'CC-NWL', 'Summer Series 2026', 'Event', pg_temp.id('root_a')) returning id)
  insert into world select 'cc_event', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code, is_baseline) values (pg_temp.id('prj_a'), 'Show budget', 'USD', true) returning id)
  insert into world select 'budget', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis, cost_center_id)
  values (pg_temp.id('budget'), 1, 'Truss rental', '0000.01.01', 1, 'X', 'Declared', pg_temp.id('cc_event')) returning id)
  insert into world select 'line1', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis, unit_price_minor)
  values (pg_temp.id('budget'), 2, 'Sound package', '0000.01.01', 2, 'X', 'Declared', 500000) returning id)
  insert into world select 'line2', id from x;
with x as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Vendor advance', '2027-02-20 22:00+00') returning id)
  insert into world select 'packet', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind, max_lines)
  values (pg_temp.id('packet'), 1, 'Passes needed', 'Credential Request', 5) returning id) insert into world select 'section', id from x;
with x as (insert into app.advance_section_choices (advance_section_id, credential_category_id) values (pg_temp.id('section'), pg_temp.id('cat_prk')) returning id)
  insert into world select 'choice_prk', id from x;
with x as (insert into app.advance_section_choices (advance_section_id, credential_category_id) values (pg_temp.id('section'), pg_temp.id('cat_aaa')) returning id)
  insert into world select 'choice_aaa', id from x;

select has_function('app', 'copy_project_setup', 'app.copy_project_setup exists');

-- The preview ----------------------------------------------------------------------------------------------------------------------
create temporary table before_rows as select pg_temp.target_rows('prj_a2') as n;
grant select on before_rows to public;
insert into pv select * from app.copy_project_setup(pg_temp.id('prj_a'), pg_temp.id('prj_a2'),
  array['Plan', 'Pass Categories', 'Hotel Blocks', 'Budgets', 'Advance Forms']::app.project_copy_part[]);
select is(pg_temp.target_rows('prj_a2'), (select n from before_rows), 'the preview writes nothing');
select is((select new_at from pv where source_id = pg_temp.id('t1')), '2027-04-02 22:00+00'::timestamptz,
  'a record at 18:00 EST moves 28 days to 18:00 EDT, across the start of daylight saving');
select is((select new_at from pv where source_id = pg_temp.id('grid_a')), '2027-03-29 12:00+00'::timestamptz,
  'an access grid window opening at 08:00 EST moves 28 days to 08:00 EDT');
select is((select new_on from pv where source_id = pg_temp.id('block')), '2027-03-28'::date, 'a hotel block''s dates move 28 days');
select is((select new_at from pv where source_id = pg_temp.id('packet')), '2027-03-20 21:00+00'::timestamptz,
  'an advance packet due at 17:00 EST moves 28 days to 17:00 EDT');
select is(pg_temp.copy_of('Pass Categories', 'cat_aaa'), 'skip:code_taken', 'a category code already on the target is skipped');
select is(pg_temp.copy_of('Pass Categories', 'grid_c'), 'skip:zone_other_venue', 'a grid row at another venue is skipped');
select is(pg_temp.copy_of('Budgets', 'line1'), 'copy:event_cost_center_cleared', 'an Event cost center is cleared and said so');
select is((select count(*)::integer from pv where source_id in (pg_temp.id('t3'), pg_temp.id('ap'))), 0,
  'Complete and Approval records are not copied');

-- The commit -----------------------------------------------------------------------------------------------------------------------
insert into cm select * from app.copy_project_setup(pg_temp.id('prj_a'), pg_temp.id('prj_a2'),
  array['Plan', 'Pass Categories', 'Hotel Blocks', 'Budgets', 'Advance Forms']::app.project_copy_part[], true);
select results_eq($$select part, item_kind, source_id, outcome, skip_reason, new_on, new_at from cm order by part, item_kind, source_id$$,
  $$select part, item_kind, source_id, outcome, skip_reason, new_on, new_at from pv order by part, item_kind, source_id$$,
  'the commit returns exactly the preview''s rows');
select is(pg_temp.target_rows('prj_a2') - (select n from before_rows),
  (select count(*)::integer from cm where outcome = 'copy' and item_kind in ('Scope Node', 'Record', 'Credential Category', 'Access Grid',
     'Hotel Block', 'Budget', 'Advance Packet', 'Project Day')),
  'and writes exactly the copied rows');
select is((select starts_at from app.records where project_id = pg_temp.id('prj_a2') and title = 'Rig the follow spots'),
  '2027-04-02 22:00+00'::timestamptz, 'the record landed at 18:00 local');
select is((select scope_code from app.scope_nodes n join app.records r on r.scope_node_id = n.id
           where r.project_id = pg_temp.id('prj_a2') and r.title = 'Rig the follow spots'), 'NWX-E01',
  'its Show node is remapped by code suffix');
select is((select p.title from app.records c join app.records p on p.id = c.parent_record_id
           where c.project_id = pg_temp.id('prj_a2') and c.title = 'Focus the follow spots'), 'Rig the follow spots',
  'the parent is remapped inside the copy');
select is((select row(p.title, s.title, d.lag)::text from app.record_dependencies d
           join app.records p on p.id = d.predecessor_record_id join app.records s on s.id = d.successor_record_id
           where s.project_id = pg_temp.id('prj_a2')),
  row('Rig the follow spots', 'Focus the follow spots', interval '2 hours')::text, 'the dependency is remapped with its lag');
select is((select row(b.is_baseline, l.unit_price_minor, l.cost_center_id)::text from app.budgets b join app.budget_lines l on l.budget_id = b.id
           where b.project_id = pg_temp.id('prj_a2') and l.line_number = 1),
  row(false, null::bigint, null::uuid)::text, 'the copied budget is not a baseline, a NULL price stays NULL and the Event cost center is gone');
select is((select string_agg(k.code, ',' order by k.code) from app.advance_section_choices ch
           join app.credential_categories k on k.id = ch.credential_category_id
           join app.advance_sections x on x.id = ch.advance_section_id join app.advance_packets p on p.id = x.advance_packet_id
           where p.project_id = pg_temp.id('prj_a2')), 'AAA,PRK', 'credential choices map by code to the target''s categories');
select is((select row(count(*), min(sent_at))::text from app.advance_packets where project_id = pg_temp.id('prj_a2')),
  row(1, null::timestamptz)::text, 'the packet is copied unsent');
select is((select row(c.offset_days, (select string_agg(p.part || '=' || p.items_copied || '/' || p.items_skipped, ', ' order by p.part)
                                        from app.project_copy_parts p where p.project_copy_id = c.id))::text
           from app.project_copies c where c.target_project_id = pg_temp.id('prj_a2')),
  row(28, 'Plan=6/0, Pass Categories=2/2, Hotel Blocks=1/0, Budgets=3/0, Advance Forms=4/0')::text,
  'one copy row and one row per part with what each copied and skipped');
select is((select (select count(*) from app.shifts where project_id = pg_temp.id('prj_a2')) + (select count(*) from app.engagements where project_id = pg_temp.id('prj_a2'))
           + (select count(*) from app.credentials where project_id = pg_temp.id('prj_a2')))::integer, 0,
  'no shift, engagement or credential is created');

-- What is already on the target.
delete from pv;
insert into pv select * from app.copy_project_setup(pg_temp.id('prj_a'), pg_temp.id('prj_a2'),
  array['Plan', 'Advance Forms']::app.project_copy_part[]);
select is((select string_agg(distinct skip_reason, ',' order by skip_reason) from pv where outcome = 'skip'), 'day_taken,scope_code_taken',
  'a second copy skips the taken scope code and the taken day');

-- Advance forms without their categories.
with x as (insert into app.projects (org_id, project_key, name, time_zone, starts_on) values (pg_temp.id('org_a'), 'NWZ', 'Northwind Fall Fair', 'America/New_York', '2027-09-06')
  returning id) insert into world select 'prj_z', id from x;
delete from pv;
insert into pv select * from app.copy_project_setup(pg_temp.id('prj_a'), pg_temp.id('prj_z'), '{Advance Forms}');
select is((select string_agg(pg_temp.copy_of('Advance Forms', k), ',' order by k) from unnest(array['choice_aaa', 'choice_prk']) k),
  'skip:category_missing,skip:category_missing', 'a credential choice with no category of its code on the target is skipped');

-- Refusals -------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.copy_project_setup(%L, %L, '{Budgets}')$$, pg_temp.id('prj_a'), pg_temp.id('prj_a2')),
  '42501', 'finance.budget.write is required on the project', 'a missing write capability is named before anything is written');
select pg_temp.as_user('carol');
select throws_ok(format($$select * from app.copy_project_setup(%L, %L, '{Plan}')$$, pg_temp.id('prj_a'), pg_temp.id('prj_b')),
  'XR001', 'copy_other_org: Copy between projects of the same organization.', 'copying to another org is refused');
select throws_ok(format($$select * from app.copy_project_setup(%L, %L, '{Plan}')$$, pg_temp.id('prj_a'), pg_temp.id('prj_a')),
  'XR001', 'copy_same_project: Choose another project to copy from.', 'copying onto itself is refused');
select throws_ok(format($$select * from app.copy_project_setup(%L, %L, '{}')$$, pg_temp.id('prj_a'), pg_temp.id('prj_a2')),
  'XR001', 'copy_nothing: Choose at least one part to copy.', 'an empty copy is refused');
with x as (insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWY', 'Northwind Year End', 'America/New_York')
  returning id) insert into world select 'prj_y', id from x;
select throws_ok(format($$select * from app.copy_project_setup(%L, %L, '{Hotel Blocks}')$$, pg_temp.id('prj_a'), pg_temp.id('prj_y')),
  'XR001', 'copy_offset_unknown: Set the show dates on both projects, or give the number of days to move everything by.',
  'with no show date on the target and no offset the copy is refused');
select pg_temp.as_platform();
insert into app.over_limit_objects (org_id, limit_code, plan_code, project_id) values (pg_temp.id('org_a'), 'active_projects', 'access', pg_temp.id('prj_y'));
select pg_temp.as_user('carol');
select throws_like(format($$select * from app.copy_project_setup(%L, %L, '{Hotel Blocks}', true, 0)$$, pg_temp.id('prj_a'), pg_temp.id('prj_y')),
  'plan_limit_read_only:%', 'a target read-only under the plan limits is refused');

-- The intake form's preview, before the project exists: at the would-be venue and zone, and nothing is left behind.
create temporary table before_projects as select count(*)::integer as n from app.projects;
grant select on before_projects to public;
delete from pv;
insert into pv select * from app.copy_project_setup(pg_temp.id('prj_a'), null, '{Plan}', false, 28, pg_temp.id('venue_a'), 'America/Chicago');
select is((select new_at from pv where source_id = pg_temp.id('t1')), '2027-04-02 23:00+00'::timestamptz,
  'with no target, 18:00 in New York previews as 18:00 in the would-be zone');
select is((select count(*)::integer from app.projects), (select n from before_projects), 'and no project is left behind');
select throws_ok(format($$select * from app.copy_project_setup(%L, null, '{Plan}', true, 28)$$, pg_temp.id('prj_a')),
  '22023', null, 'a commit needs a target');

-- More than 2000 items.
insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
select pg_temp.id('prj_a'), 'Task', 'Execute', 'Label cable run ' || g, 'Y', 'Declared' from generate_series(1, 2000) g;
select throws_like(format($$select * from app.copy_project_setup(%L, %L, '{Plan}')$$, pg_temp.id('prj_a'), pg_temp.id('prj_a2')),
  'copy_too_large:%', 'a copy of more than 2000 items is refused');

select * from finish();
rollback;
