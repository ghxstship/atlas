-- 3036_project_copy.sql
-- B14 Event types and project setup (RRR-238; parity gap G-252; ADR 0153 decision D4; block 3030 to 3039). Copy from
-- the last event: a direct project-to-project copy of the org-owned setup of a past project, shifted by a number of
-- days on the project's wall clock. Templates are not widened.
--
--   * Parts: Plan (Show and Standing Venue scope nodes, open records with their parents and dependencies, and B4's
--     project days), Pass Categories (credential categories and their access grid at the target's venues), Hotel Blocks,
--     Budgets (as new, non-baseline budgets) and Advance Forms (packets, sections and choices, unsent).
--   * Never copied: shifts, engagements, people, credentials issued, allocations, submissions, advance recipients,
--     roster facts, record owners, record extension rows, hotel assignments and project offering rules and settings
--     (2620, 2621). They are bookings, commercial terms, consented personal data or the party's own answers (D4).
--   * app.copy_project_setup previews and commits the same rows. The writes run inside a BEGIN ... EXCEPTION block; a
--     preview raises the private sentinel XB001 that rolls them back while the result rows stay in a jsonb accumulator
--     outside the block, the pattern of 1451's private.run_bulk. With no target (the intake wizard, before the project
--     exists) the preview runs against a stand-in project in the same block, at the would-be venue and zone, so a skip
--     that depends on the target (scope_code_taken, code_taken, day_taken) cannot occur; a commit needs a target.
--   * The caller needs, per part, the read capability on the source and the write capabilities on the target (42501
--     naming it, before anything is written). Every guard of the target tables runs as for a hand-made row
--     (plan_limit_read_only, production_closed, title grammar).
--   * A commit records one app.project_copies row and one app.project_copy_parts row per part, and emits
--     project.copied. Both tables are append-only facts, not derived totals, and stay out of Trash and of the
--     denormalization register, like template_applications.
-- No view is created, so 1650's xos_backup rule does not apply.

create type app.project_copy_part as enum ('Plan', 'Pass Categories', 'Hotel Blocks', 'Budgets', 'Advance Forms');
comment on type app.project_copy_part is 'A part of a project''s setup copied from another project (G-252, ADR 0153 D4): Plan (scope nodes, open records, dependencies and project days), Pass Categories (credential categories and their access grid), Hotel Blocks, Budgets and Advance Forms.';

insert into private.domain_event_types (code, subject, description) values
  ('project.copied', 'projects', 'Setup was copied into the project from another project of the org: the parts, the offset in days and what was copied and skipped.')
on conflict (code) do nothing;

-- The facts of a copy ---------------------------------------------------------------------------------------------------------

create table app.project_copies (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  source_project_id uuid not null references app.projects (id),
  target_project_id uuid not null references app.projects (id),
  offset_days integer not null,
  constraint project_copies_offset check (offset_days between -3660 and 3660),
  constraint project_copies_distinct check (source_project_id <> target_project_id)
);

create index project_copies_source_idx on app.project_copies (source_project_id);
create index project_copies_target_idx on app.project_copies (target_project_id);

call private.install_domain_table('app.project_copies', null, null,
  array['app.projects', 'source_project_id', 'app.projects', 'target_project_id'], true);
call private.describe('app.project_copies', 'Append-only record of each committed copy of setup from one project into another of the same org (G-252, ADR 0153 D4). Written by app.copy_project_setup.', array[
  'org_id', 'Owning org, the org of both projects. A row never moves to another org.',
  'source_project_id', 'Project the setup was copied from.',
  'target_project_id', 'Project the setup was copied into.',
  'offset_days', 'Days every date and time moved by on the wall clock, -3660 to 3660.'
]);
create policy project_copies_read on app.project_copies for select to authenticated
  using (source_project_id in (select private.readable_project_ids()) and target_project_id in (select private.readable_project_ids()));
call private.install_default_retention('app.project_copies');

create table app.project_copy_parts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_copy_id uuid not null references app.project_copies (id),
  part app.project_copy_part not null,
  items_copied integer not null,
  items_skipped integer not null,
  constraint project_copy_parts_items check (items_copied >= 0 and items_skipped >= 0)
);

create unique index project_copy_parts_part_key on app.project_copy_parts (project_copy_id, part);

call private.install_domain_table('app.project_copy_parts', 'app.project_copies', 'project_copy_id', '{}', true);
call private.describe('app.project_copy_parts', 'One row per part of a committed copy (G-252): what it copied and skipped, as copied. Event facts, not derived totals.', array[
  'project_copy_id', 'Copy the part belongs to.',
  'part', 'Part copied.',
  'items_copied', 'Items the part copied, as copied.',
  'items_skipped', 'Items the part left out, each with its reason in the copy''s result.'
]);
create policy project_copy_parts_read on app.project_copy_parts for select to authenticated
  using (project_copy_id in (select c.id from app.project_copies c
    where c.source_project_id in (select private.readable_project_ids())
      and c.target_project_id in (select private.readable_project_ids())));
call private.install_default_retention('app.project_copy_parts');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('project_copies', 'Append-only facts of a copy; the copied rows themselves go to Trash one by one.'),
  ('project_copy_parts', 'Append-only facts of a copy''s parts; the copied rows themselves go to Trash one by one.');

-- Moving an instant on the wall clock -----------------------------------------------------------------------------------------------

create or replace function private.shift_wall_clock(p_at timestamptz, p_days integer, p_from_zone text, p_to_zone text)
returns timestamptz
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_at is null then null
    else ((p_at at time zone p_from_zone) + pg_catalog.make_interval(days => p_days)) at time zone p_to_zone end;
$$;

comment on function private.shift_wall_clock(timestamptz, integer, text, text) is 'An instant moved by whole days on the wall clock (G-252, ADR 0153 C11): its local time in the source zone, plus the days, read in the target zone. With equal zones it equals private.add_local_days (2260), so 18:00 stays 18:00 across a daylight saving change.';
revoke all on function private.shift_wall_clock(timestamptz, integer, text, text) from public, anon;
grant execute on function private.shift_wall_clock(timestamptz, integer, text, text) to authenticated, service_role;

create or replace function private.copy_result(
  p_part app.project_copy_part,
  p_item_kind text,
  p_source_id uuid,
  p_label text,
  p_skip_reason text default null,
  p_skipped boolean default false,
  p_new_on date default null,
  p_new_at timestamptz default null
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'part', p_part, 'item_kind', p_item_kind, 'source_id', p_source_id, 'label', p_label,
    'outcome', case when p_skipped then 'skip' else 'copy' end, 'skip_reason', p_skip_reason,
    'new_on', p_new_on, 'new_at', p_new_at));
$$;

comment on function private.copy_result(app.project_copy_part, text, uuid, text, text, boolean, date, timestamptz) is 'One result row of app.copy_project_setup as a one-element jsonb array to append to its accumulator.';
revoke all on function private.copy_result(app.project_copy_part, text, uuid, text, text, boolean, date, timestamptz) from public, anon, authenticated;

-- The copy ----------------------------------------------------------------------------------------------------------------------------

create or replace function app.copy_project_setup(
  p_source_project_id uuid,
  p_target_project_id uuid,
  p_parts app.project_copy_part[],
  p_commit boolean default false,
  p_offset_days integer default null,
  p_target_venue_id uuid default null,
  p_target_time_zone text default null
)
returns table (
  part app.project_copy_part,
  item_kind text,
  source_id uuid,
  label text,
  outcome text,
  skip_reason text,
  new_on date,
  new_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.require_person();
  v_src app.projects;
  v_tgt app.projects;
  v_parts app.project_copy_part[];
  v_part app.project_copy_part;
  v_offset integer;
  v_cap text;
  v_reads text[];
  v_writes text[];
  v_items integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_root uuid;
  v_key text;
  v_nodes jsonb := '{}'::jsonb;
  v_records jsonb := '{}'::jsonb;
  v_categories jsonb := '{}'::jsonb;
  v_days date[] := '{}';
  v_timeline boolean;
  v_id uuid;
  v_other uuid;
  v_zone_from text;
  v_zone_to text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_due timestamptz;
  v_reason text;
  v_venue uuid;
  v_zone text;
  v_copy uuid;
  v_packet uuid;
  v_section uuid;
  r record;
  s record;
  c record;
begin
  if p_parts is null or coalesce(cardinality(p_parts), 0) = 0 then
    perform private.refuse('copy_nothing', 'Choose at least one part to copy.');
  end if;
  v_parts := array(select distinct x from unnest(p_parts) x where x is not null order by x);
  select * into v_src from app.projects p where p.id = p_source_project_id and p.deleted_at is null;
  if v_src.id is null then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  if p_target_project_id is not null then
    select * into v_tgt from app.projects p where p.id = p_target_project_id and p.deleted_at is null;
    if v_tgt.id is null then
      raise exception using errcode = '42501', message = 'project not found';
    end if;
    if v_tgt.org_id <> v_src.org_id then
      perform private.refuse('copy_other_org', 'Copy between projects of the same organization.');
    end if;
    if v_tgt.id = v_src.id then
      perform private.refuse('copy_same_project', 'Choose another project to copy from.');
    end if;
  elsif coalesce(p_commit, false) then
    raise exception using errcode = '22023', message = 'a copy is committed into a project';
  end if;
  v_offset := coalesce(p_offset_days, v_tgt.starts_on - v_src.starts_on);
  if v_offset is null then
    perform private.refuse('copy_offset_unknown', 'Set the show dates on both projects, or give the number of days to move everything by.');
  end if;
  if v_offset not between -3660 and 3660 then
    raise exception using errcode = '22023', message = 'a copy moves dates by at most 3660 days';
  end if;

  -- Every capability before anything is written.
  foreach v_part in array v_parts loop
    case v_part
      when 'Plan' then v_reads := array['work.record.read']; v_writes := array['work.record.write', 'projects.scope.write'];
      when 'Pass Categories' then v_reads := array['credentials.credential.read'];
        v_writes := array['credentials.category.write', 'credentials.access_grid.write'];
      when 'Hotel Blocks' then v_reads := array['hospitality.fulfillment.read']; v_writes := array['hospitality.accommodation.write'];
      when 'Budgets' then v_reads := array['finance.budget.read']; v_writes := array['finance.budget.write'];
      when 'Advance Forms' then v_reads := array['advancing.packet.read']; v_writes := array['advancing.packet.write'];
    end case;
    foreach v_cap in array v_reads loop
      if not private.can_on_project(v_src.id, v_cap) then
        raise exception using errcode = '42501', message = format('%s is required on the source project', v_cap);
      end if;
    end loop;
    foreach v_cap in array v_writes loop
      if v_tgt.id is not null and not private.can_on_project(v_tgt.id, v_cap) then
        raise exception using errcode = '42501', message = format('%s is required on the project', v_cap);
      elsif v_tgt.id is null and not private.has_capability(v_src.org_id, v_cap) then
        raise exception using errcode = '42501', message = format('%s is required on the new project', v_cap);
      end if;
    end loop;
  end loop;
  v_timeline := case when v_tgt.id is not null then private.can_on_project(v_tgt.id, 'schedule.timeline.write')
                     else private.has_capability(v_src.org_id, 'schedule.timeline.write') end;

  -- The size, before anything is written.
  if 'Plan' = any (v_parts) then
    v_items := v_items
      + (select count(*) from app.scope_nodes n where n.project_id = v_src.id and n.parent_id is not null and n.deleted_at is null
           and n.scope_kind in ('Show', 'Standing Venue') and n.scope_code like v_src.project_key || '-%')
      + (select count(*) + count(r2.parent_record_id) from app.records r2 where r2.project_id = v_src.id and r2.deleted_at is null
           and r2.record_state not in ('Complete', 'Canceled') and r2.record_kind <> 'Approval')
      + (select count(*) from app.record_dependencies d join app.records r2 on r2.id = d.successor_record_id
           where r2.project_id = v_src.id and d.deleted_at is null and r2.deleted_at is null)
      + (select count(*) from app.project_days d where d.project_id = v_src.id and d.deleted_at is null);
  end if;
  if 'Pass Categories' = any (v_parts) then
    v_items := v_items
      + (select count(*) from app.credential_categories k where k.project_id = v_src.id and k.deleted_at is null)
      + (select count(*) from app.access_grid g join app.credential_categories k on k.id = g.credential_category_id
           where k.project_id = v_src.id and k.deleted_at is null and g.deleted_at is null);
  end if;
  if 'Hotel Blocks' = any (v_parts) then
    v_items := v_items + (select count(*) from app.accommodation_blocks b where b.project_id = v_src.id and b.deleted_at is null);
  end if;
  if 'Budgets' = any (v_parts) then
    v_items := v_items
      + (select count(*) from app.budgets b where b.project_id = v_src.id and b.deleted_at is null)
      + (select count(*) from app.budget_lines l join app.budgets b on b.id = l.budget_id
           where b.project_id = v_src.id and b.deleted_at is null and l.deleted_at is null);
  end if;
  if 'Advance Forms' = any (v_parts) then
    v_items := v_items
      + (select count(*) from app.advance_packets k where k.project_id = v_src.id and k.deleted_at is null)
      + (select count(*) from app.advance_sections x join app.advance_packets k on k.id = x.advance_packet_id
           where k.project_id = v_src.id and k.deleted_at is null and x.deleted_at is null)
      + (select count(*) from app.advance_section_choices ch join app.advance_sections x on x.id = ch.advance_section_id
           join app.advance_packets k on k.id = x.advance_packet_id
           where k.project_id = v_src.id and k.deleted_at is null and x.deleted_at is null and ch.deleted_at is null);
  end if;
  if v_items > 2000 then
    perform private.refuse('copy_too_large', format('This copy has %s items, more than 2,000; copy fewer parts at a time.', v_items));
  end if;

  begin
    if v_tgt.id is null then
      -- The intake wizard's preview: a stand-in for the project about to be created, rolled back with the rest.
      loop
        v_key := (select string_agg(chr(65 + floor(random() * 26)::integer), '') from generate_series(1, 5));
        exit when not exists (select 1 from app.projects p where p.org_id = v_src.org_id and p.project_key = v_key and p.deleted_at is null);
      end loop;
      insert into app.projects (org_id, project_key, name, time_zone, venue_id, starts_on, ends_on, currency)
      values (v_src.org_id, v_key, v_src.name, coalesce(nullif(btrim(p_target_time_zone), ''), v_src.time_zone), p_target_venue_id,
        v_src.starts_on + v_offset, v_src.ends_on + v_offset, v_src.currency)
      returning * into v_tgt;
      insert into app.scope_nodes (project_id, scope_kind, scope_code, name, venue_id, path)
      values (v_tgt.id, 'Engagement Root', v_key || '-E01', v_tgt.name, v_tgt.venue_id, extensions.text2ltree(v_key || '_E01'));
    end if;
    select n.id into v_root from app.scope_nodes n where n.project_id = v_tgt.id and n.parent_id is null and n.deleted_at is null;

    -- Plan -----------------------------------------------------------------------------------------------------------------------
    if 'Plan' = any (v_parts) then
      for r in
        select n.id, n.scope_kind, n.scope_code, n.name, n.venue_id,
          substr(n.scope_code, char_length(v_src.project_key) + 2) as suffix
        from app.scope_nodes n
        where n.project_id = v_src.id and n.parent_id is not null and n.deleted_at is null
          and n.scope_kind in ('Show', 'Standing Venue') and n.scope_code like v_src.project_key || '-%'
        order by n.path, n.id
      loop
        select n.id into v_other from app.scope_nodes n
        where n.project_id = v_tgt.id and n.scope_code = v_tgt.project_key || '-' || r.suffix and n.deleted_at is null;
        if v_other is not null then
          v_nodes := v_nodes || jsonb_build_object(r.id::text, v_other);
          v_rows := v_rows || private.copy_result('Plan', 'Scope Node', r.id, r.name, 'scope_code_taken', true);
        else
          insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, venue_id)
          values (v_tgt.id, v_root, r.scope_kind, v_tgt.project_key || '-' || r.suffix, r.name,
            case when r.venue_id is not distinct from v_src.venue_id then v_tgt.venue_id else r.venue_id end)
          returning id into v_id;
          v_nodes := v_nodes || jsonb_build_object(r.id::text, v_id);
          v_rows := v_rows || private.copy_result('Plan', 'Scope Node', r.id, r.name);
        end if;
      end loop;

      for r in
        select x.* from app.records x
        where x.project_id = v_src.id and x.deleted_at is null and x.record_state not in ('Complete', 'Canceled')
          and x.record_kind <> 'Approval'
        order by x.record_number, x.id
      loop
        v_zone_from := coalesce(r.time_zone, v_src.time_zone);
        v_zone_to := coalesce(r.time_zone, v_tgt.time_zone);
        v_starts := private.shift_wall_clock(r.starts_at, v_offset, v_zone_from, v_zone_to);
        v_ends := private.shift_wall_clock(r.ends_at, v_offset, v_zone_from, v_zone_to);
        v_due := private.shift_wall_clock(r.due_at, v_offset, v_zone_from, v_zone_to);
        insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, phase_code, urid, xyz, xyz_basis,
          starts_at, ends_at, due_at, time_zone, description, wbs_code, team_code, sop_id, start_tbc, anchor_pinned, requires_review)
        values (v_tgt.id, coalesce((v_nodes ->> r.scope_node_id::text)::uuid, v_root), r.record_kind, r.record_subtype, r.title,
          r.phase_code, r.urid, r.xyz, r.xyz_basis, v_starts, v_ends, v_due, r.time_zone, r.description, r.wbs_code, r.team_code,
          r.sop_id, r.start_tbc, r.anchor_pinned, r.requires_review)
        returning id into v_id;
        v_records := v_records || jsonb_build_object(r.id::text, v_id);
        v_rows := v_rows || private.copy_result('Plan', 'Record', r.id, r.title, null, false,
          (coalesce(v_starts, v_due) at time zone v_zone_to)::date, coalesce(v_starts, v_due));
      end loop;

      for r in
        select x.id, x.title, x.parent_record_id from app.records x
        where x.project_id = v_src.id and x.deleted_at is null and x.record_state not in ('Complete', 'Canceled')
          and x.record_kind <> 'Approval' and x.parent_record_id is not null
        order by x.record_number, x.id
      loop
        if v_records ? r.parent_record_id::text then
          update app.records set parent_record_id = (v_records ->> r.parent_record_id::text)::uuid
          where id = (v_records ->> r.id::text)::uuid;
          v_rows := v_rows || private.copy_result('Plan', 'Record Parent', r.id, r.title);
        else
          v_rows := v_rows || private.copy_result('Plan', 'Record Parent', r.id, r.title, 'outside_copy', true);
        end if;
      end loop;

      for r in
        select d.id, d.predecessor_record_id, d.successor_record_id, d.dependency_type, d.lag,
          pr.title || ', ' || sr.title as caption
        from app.record_dependencies d
        join app.records sr on sr.id = d.successor_record_id
        join app.records pr on pr.id = d.predecessor_record_id
        where sr.project_id = v_src.id and d.deleted_at is null and sr.deleted_at is null and pr.deleted_at is null
        order by d.created_at, d.id
      loop
        if not (v_records ? r.predecessor_record_id::text and v_records ? r.successor_record_id::text) then
          v_rows := v_rows || private.copy_result('Plan', 'Dependency', r.id, r.caption, 'outside_copy', true);
        elsif not v_timeline then
          v_rows := v_rows || private.copy_result('Plan', 'Dependency', r.id, r.caption, 'dependency_needs_timeline', true);
        else
          insert into app.record_dependencies (predecessor_record_id, successor_record_id, dependency_type, lag)
          values ((v_records ->> r.predecessor_record_id::text)::uuid, (v_records ->> r.successor_record_id::text)::uuid,
            r.dependency_type, r.lag);
          v_rows := v_rows || private.copy_result('Plan', 'Dependency', r.id, r.caption);
        end if;
      end loop;

      for r in
        select d.* from app.project_days d where d.project_id = v_src.id and d.deleted_at is null
        order by d.day_on, d.sort_order, d.id
      loop
        if not v_timeline then
          v_rows := v_rows || private.copy_result('Plan', 'Project Day', r.id, coalesce(r.label, r.day_type::text),
            'day_needs_timeline', true, r.day_on + v_offset);
          continue;
        end if;
        if not ((r.day_on + v_offset) = any (v_days))
           and exists (select 1 from app.project_days d where d.project_id = v_tgt.id and d.day_on = r.day_on + v_offset
                       and d.deleted_at is null) then
          v_rows := v_rows || private.copy_result('Plan', 'Project Day', r.id, coalesce(r.label, r.day_type::text),
            'day_taken', true, r.day_on + v_offset);
          continue;
        end if;
        v_other := (v_nodes ->> r.scope_node_id::text)::uuid;
        v_venue := case when v_other is not null then null
                        when r.venue_id is not distinct from v_src.venue_id then v_tgt.venue_id else r.venue_id end;
        v_zone := case when v_venue is not null then null
                       when v_other is not null and exists (select 1 from app.scope_nodes n where n.id = v_other and n.venue_id is not null) then null
                       else r.time_zone end;
        insert into app.project_days (project_id, day_on, day_type, sort_order, label, venue_id, location_text, time_zone,
          scope_node_id, team_code)
        values (v_tgt.id, r.day_on + v_offset, r.day_type, r.sort_order, r.label, v_venue, r.location_text, v_zone, v_other,
          r.team_code);
        v_days := v_days || (r.day_on + v_offset);
        v_rows := v_rows || private.copy_result('Plan', 'Project Day', r.id, coalesce(r.label, r.day_type::text), null, false,
          r.day_on + v_offset);
      end loop;
    end if;

    -- Pass Categories ----------------------------------------------------------------------------------------------------------
    if 'Pass Categories' = any (v_parts) then
      for r in
        select k.id, k.code, k.name, k.category_kind from app.credential_categories k
        where k.project_id = v_src.id and k.deleted_at is null order by k.code
      loop
        select k.id into v_other from app.credential_categories k
        where k.project_id = v_tgt.id and k.code = r.code and k.deleted_at is null;
        if v_other is not null then
          v_categories := v_categories || jsonb_build_object(r.code, v_other);
          v_rows := v_rows || private.copy_result('Pass Categories', 'Credential Category', r.id, r.code || ' ' || r.name,
            'code_taken', true);
        else
          insert into app.credential_categories (project_id, code, name, category_kind)
          values (v_tgt.id, r.code, r.name, r.category_kind) returning id into v_id;
          v_categories := v_categories || jsonb_build_object(r.code, v_id);
          v_rows := v_rows || private.copy_result('Pass Categories', 'Credential Category', r.id, r.code || ' ' || r.name);
        end if;
      end loop;
      for r in
        select g.id, g.zone_id, g.access_level_enum_id, g.window_starts_at, g.window_ends_at, k.code, z.venue_id,
          k.code || ' ' || z.name as caption
        from app.access_grid g
        join app.credential_categories k on k.id = g.credential_category_id
        join app.zones z on z.id = g.zone_id
        where k.project_id = v_src.id and k.deleted_at is null and g.deleted_at is null
        order by k.code, z.code, g.window_starts_at, g.id
      loop
        if r.venue_id is distinct from v_tgt.venue_id and not exists (
            select 1 from app.scope_nodes n
            where n.project_id = v_tgt.id and n.deleted_at is null and n.scope_kind = 'Show' and n.venue_id = r.venue_id) then
          v_rows := v_rows || private.copy_result('Pass Categories', 'Access Grid', r.id, r.caption, 'zone_other_venue', true);
        else
          v_starts := private.shift_wall_clock(r.window_starts_at, v_offset, v_src.time_zone, v_tgt.time_zone);
          insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
          values ((v_categories ->> r.code)::uuid, r.zone_id, r.access_level_enum_id, v_starts,
            private.shift_wall_clock(r.window_ends_at, v_offset, v_src.time_zone, v_tgt.time_zone));
          v_rows := v_rows || private.copy_result('Pass Categories', 'Access Grid', r.id, r.caption, null, false,
            (v_starts at time zone v_tgt.time_zone)::date, v_starts);
        end if;
      end loop;
    end if;

    -- Hotel Blocks -------------------------------------------------------------------------------------------------------------
    if 'Hotel Blocks' = any (v_parts) then
      for r in
        select b.* from app.accommodation_blocks b where b.project_id = v_src.id and b.deleted_at is null
        order by b.block_number, b.id
      loop
        insert into app.accommodation_blocks (project_id, counterparty_id, title, check_in_on, check_out_on, rooms_held, release_on,
          nightly_rate_minor, currency_code)
        values (v_tgt.id, r.counterparty_id, r.title, r.check_in_on + v_offset, r.check_out_on + v_offset, r.rooms_held,
          r.release_on + v_offset, r.nightly_rate_minor, r.currency_code);
        v_rows := v_rows || private.copy_result('Hotel Blocks', 'Hotel Block', r.id, r.title, null, false, r.check_in_on + v_offset);
      end loop;
    end if;

    -- Budgets ----------------------------------------------------------------------------------------------------------------------
    if 'Budgets' = any (v_parts) then
      for s in
        select b.id, b.name, b.currency_code from app.budgets b where b.project_id = v_src.id and b.deleted_at is null
        order by b.created_at, b.id
      loop
        insert into app.budgets (project_id, name, currency_code, is_baseline)
        values (v_tgt.id, s.name, s.currency_code, false) returning id into v_id;
        v_rows := v_rows || private.copy_result('Budgets', 'Budget', s.id, s.name);
        for r in
          select l.*, cc.kind as cost_center_kind from app.budget_lines l
          left join app.cost_centers cc on cc.id = l.cost_center_id
          where l.budget_id = s.id and l.deleted_at is null order by l.line_number, l.id
        loop
          v_reason := case when r.cost_center_kind = 'Event' then 'event_cost_center_cleared' end;
          insert into app.budget_lines (budget_id, line_number, description, line_type, urid, cost_center_id, grade_code, element_id,
            quantity, unit_basis, unit_price_minor, xyz, xyz_basis, phase_code, tier_code)
          values (v_id, r.line_number, r.description, r.line_type, r.urid,
            case when r.cost_center_kind = 'Event' then null else r.cost_center_id end, r.grade_code, r.element_id, r.quantity,
            r.unit_basis, r.unit_price_minor, r.xyz, r.xyz_basis, r.phase_code, r.tier_code);
          v_rows := v_rows || private.copy_result('Budgets', 'Budget Line', r.id, s.name || ' ' || r.line_number || ' ' || r.description,
            v_reason);
        end loop;
      end loop;
    end if;

    -- Advance Forms ----------------------------------------------------------------------------------------------------------------
    if 'Advance Forms' = any (v_parts) then
      for s in
        select k.id, k.title, k.due_at from app.advance_packets k where k.project_id = v_src.id and k.deleted_at is null
        order by k.created_at, k.id
      loop
        v_due := private.shift_wall_clock(s.due_at, v_offset, v_src.time_zone, v_tgt.time_zone);
        insert into app.advance_packets (project_id, title, due_at) values (v_tgt.id, s.title, v_due) returning id into v_packet;
        v_rows := v_rows || private.copy_result('Advance Forms', 'Advance Packet', s.id, s.title, null, false,
          (v_due at time zone v_tgt.time_zone)::date, v_due);
        for r in
          select x.* from app.advance_sections x where x.advance_packet_id = s.id and x.deleted_at is null order by x.position, x.id
        loop
          insert into app.advance_sections (advance_packet_id, position, title, prompt, section_kind, window_kind, max_lines, per_person)
          values (v_packet, r.position, r.title, r.prompt, r.section_kind, r.window_kind, r.max_lines, r.per_person)
          returning id into v_section;
          v_rows := v_rows || private.copy_result('Advance Forms', 'Advance Section', r.id, s.title || ': ' || r.title);
          for c in
            select ch.id, ch.asset_class_id, k.code as category_code,
              coalesce(ac.name, k.code || ' ' || k.name) as caption
            from app.advance_section_choices ch
            left join app.asset_classes ac on ac.id = ch.asset_class_id
            left join app.credential_categories k on k.id = ch.credential_category_id
            where ch.advance_section_id = r.id and ch.deleted_at is null order by ch.created_at, ch.id
          loop
            if c.asset_class_id is not null then
              insert into app.advance_section_choices (advance_section_id, asset_class_id) values (v_section, c.asset_class_id);
              v_rows := v_rows || private.copy_result('Advance Forms', 'Section Choice', c.id, c.caption);
            else
              -- By code, to the target's live category, which the Pass Categories part may have just created.
              select k.id into v_other from app.credential_categories k
              where k.project_id = v_tgt.id and k.code = c.category_code and k.deleted_at is null;
              if v_other is null then
                v_rows := v_rows || private.copy_result('Advance Forms', 'Section Choice', c.id, c.caption, 'category_missing', true);
              else
                insert into app.advance_section_choices (advance_section_id, credential_category_id) values (v_section, v_other);
                v_rows := v_rows || private.copy_result('Advance Forms', 'Section Choice', c.id, c.caption);
              end if;
            end if;
          end loop;
        end loop;
      end loop;
    end if;

    if not coalesce(p_commit, false) then
      raise exception using errcode = 'XB001', message = 'copy preview undone';
    end if;

    insert into app.project_copies (org_id, source_project_id, target_project_id, offset_days)
    values (v_tgt.org_id, v_src.id, v_tgt.id, v_offset) returning id into v_copy;
    insert into app.project_copy_parts (project_copy_id, part, items_copied, items_skipped)
    select v_copy, p.x,
      (select count(*) from jsonb_array_elements(v_rows) e where (e ->> 'part')::app.project_copy_part = p.x and e ->> 'outcome' = 'copy'),
      (select count(*) from jsonb_array_elements(v_rows) e where (e ->> 'part')::app.project_copy_part = p.x and e ->> 'outcome' = 'skip')
    from unnest(v_parts) p (x);
    perform private.emit_event(v_tgt.org_id, 'project.copied', 'projects', v_tgt.id, v_tgt.id, jsonb_build_object(
      'project_copy_id', v_copy, 'source_project_id', v_src.id, 'offset_days', v_offset, 'parts', to_jsonb(v_parts),
      'copied', (select count(*) from jsonb_array_elements(v_rows) e where e ->> 'outcome' = 'copy'),
      'skipped', (select count(*) from jsonb_array_elements(v_rows) e where e ->> 'outcome' = 'skip')));
  exception when sqlstate 'XB001' then
    null;
  end;

  return query
  select (e.value ->> 'part')::app.project_copy_part, e.value ->> 'item_kind', (e.value ->> 'source_id')::uuid, e.value ->> 'label',
    e.value ->> 'outcome', e.value ->> 'skip_reason', (e.value ->> 'new_on')::date, (e.value ->> 'new_at')::timestamptz
  from jsonb_array_elements(v_rows) with ordinality e (value, ord)
  order by e.ord;
end;
$$;

comment on function app.copy_project_setup(uuid, uuid, app.project_copy_part[], boolean, integer, uuid, text) is 'Copies the org-owned setup of a past project into another of the same org (G-252, ADR 0153 D4), every date moved by the offset (p_offset_days, else the difference of the projects'' starts_on; copy_offset_unknown without either; at most 3660 days, 22023) and every time moved by whole days on the wall clock (private.shift_wall_clock). Plan: Show and Standing Venue scope nodes by code suffix (scope_code_taken), live records that are not Complete, Canceled or Approval records in Proposed with no owner, their parents and dependencies within the copy (outside_copy; dependency_needs_timeline without schedule.timeline.write), and project days (day_taken on a date the target already has; day_needs_timeline). Pass Categories: categories by code (code_taken, its grid rows going to the existing category) and access grid rows at the target''s venue or a venue of its Show nodes (zone_other_venue). Hotel Blocks without assignments. Budgets as new non-baseline budgets with their lines (unit prices kept, NULL as NULL; an Event cost center cleared, event_cost_center_cleared). Advance Forms unsent, with sections and choices (a credential category choice maps by code to the target''s live category, else category_missing). Never copies shifts, engagements, people, credentials, allocations, recipients, submissions, roster facts or offering rules. Refuses copy_nothing, copy_other_org, copy_same_project and copy_too_large (over 2000 items), and 42501 naming each capability a part needs (the read capability on the source, the write capabilities on the target) before anything is written; every guard of the target tables applies (plan_limit_read_only, production_closed, title grammar). Preview (p_commit false) writes nothing and returns the rows a commit returns; with no target it previews against the would-be venue (p_target_venue_id) and zone (p_target_time_zone), and a commit needs a target. A commit records app.project_copies and one app.project_copy_parts row per part and emits project.copied. Returns one row per item: copy or skip, the reason, and its new date and time.';
revoke all on function app.copy_project_setup(uuid, uuid, app.project_copy_part[], boolean, integer, uuid, text) from public, anon;
grant execute on function app.copy_project_setup(uuid, uuid, app.project_copy_part[], boolean, integer, uuid, text) to authenticated, service_role;

select private.sync_trash_tables();
