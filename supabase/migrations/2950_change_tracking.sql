-- 2950_change_tracking.sql
--
-- B6 (RRR-230, G-249, G-65, G-120, G-179; ADR 0145, block 2950-2959). One mechanism answers "what changed since you
-- last looked, or were last told": the diff is always computed from the audit ledger (app.audit_events, 0501) against
-- one instant per person, and never stored. This migration:
--   * gives app.travel_segments, app.accommodation_assignments and app.cues an audit trail and makes them field
--     history subjects (1452), so the itinerary and the Show day page can say what moved. Each cue call now adds one
--     ledger event;
--   * private.audit_field_changes and private.audit_changes_since read one row's events after an instant, its own and
--     its 1:1 extension rows' (2240), and name the fields that changed, never their values. A column signed-in people
--     cannot select, and a Restricted column, never appears;
--   * app.changes_since answers that for up to 200 rows a caller can read, leaving out the caller's own changes;
--   * app.seen_marks keeps when a person last looked at Today, an engagement's itinerary or a project's Show day.
--     A visit is a 30-minute window: the baseline a page compares against moves forward only when a visit starts 30
--     minutes or more after the previous one started, so a refresh never clears the highlights. Mark all as seen moves
--     it to now. Marks are personal UI state with no v1 operation, as recent views (1440) have none;
--   * app.today_changes lists what others changed on the records a person is assigned to or watches, and on their own
--     shifts, since their last visit to Today.

-- 1. Audit trails and history subjects ------------------------------------------------------------------------------------

call private.install_audit_trail('app.travel_segments');
call private.install_audit_trail('app.accommodation_assignments');
call private.install_audit_trail('app.cues');

insert into private.field_history_subjects (table_name) values ('app.travel_segments'), ('app.accommodation_assignments'), ('app.cues') on conflict (table_name) do nothing;

-- 2. What changed on one row after an instant ------------------------------------------------------------------------------

create or replace function private.audit_field_changes(p_subject_table text, p_subject_id uuid, p_since timestamptz, p_skip_actor uuid)
returns table (
  event_id uuid,
  operation text,
  field text,
  new_value jsonb,
  changed_at timestamptz,
  actor_person_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with sources as (
    select p_subject_table as table_name, null::text as key_column, null::text as field_prefix
    union all
    select x.table_name, x.key_column, x.field_prefix
    from private.field_history_extensions x
    where x.subject_table = p_subject_table
  ),
  events as (
    select e.id, e.created_at, e.actor_person_id, e.diff, s.table_name, s.key_column, s.field_prefix,
           split_part(e.action, '.', 2) as op
    from app.audit_events e
    join sources s on s.table_name = e.subject_table
    where e.subject_id = p_subject_id and e.created_at > p_since
      and split_part(e.action, '.', 2) in ('insert', 'update', 'delete')
      and (p_skip_actor is null or e.actor_person_id is distinct from p_skip_actor)
  ),
  fields as (
    -- The row's own updates. Setting deleted_at is a removal, reported below; setting it back to null is a restore,
    -- which names the field.
    select ev.id, ev.created_at, ev.actor_person_id, ev.table_name, f.key as column_name, f.key as field, f.value
    from events ev
    cross join lateral jsonb_each(coalesce(ev.diff -> 'new', '{}'::jsonb)) f
    where ev.field_prefix is null and ev.op = 'update' and f.key not in ('id', 'org_id')
      and (f.key <> 'deleted_at' or f.value = 'null'::jsonb)
    union all
    -- An extension row's change is a change of the row's attributes, as app.field_history reads it (2240).
    select ev.id, ev.created_at, ev.actor_person_id, ev.table_name, f.key, ev.field_prefix || '.' || f.key,
           case when ev.op = 'delete' then 'null'::jsonb else f.value end
    from events ev
    cross join lateral jsonb_each(coalesce(ev.diff -> case when ev.op = 'delete' then 'old' else 'new' end, '{}'::jsonb)) f
    where ev.field_prefix is not null
      and f.key not in (ev.key_column, 'org_id', 'record_kind', 'deleted_at')
      and (ev.op = 'update' or f.value <> 'null'::jsonb)
  )
  select ev.id,
         case when ev.op = 'update' then 'remove' else ev.op end,
         null::text, null::jsonb, ev.created_at, ev.actor_person_id
  from events ev
  where ev.field_prefix is null
    and (ev.op in ('insert', 'delete')
      or (ev.op = 'update' and coalesce(ev.diff -> 'new' -> 'deleted_at', 'null'::jsonb) <> 'null'::jsonb))
  union all
  select f.id, 'update', f.field, f.value, f.created_at, f.actor_person_id
  from fields f
  left join pg_catalog.pg_attribute a
    on a.attrelid = f.table_name::regclass and a.attname = f.column_name and not a.attisdropped
  where (a.attnum is null or pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT'))
    and not exists (
      select 1 from private.column_classifications c
      where c.table_name = f.table_name and c.column_name = f.column_name and c.classification = 'Restricted');
$$;

comment on function private.audit_field_changes(text, uuid, timestamptz, uuid) is 'B6 (ADR 0145): the ledger events of one field history subject row, and of its 1:1 extension rows (private.field_history_extensions), strictly after an instant, without those of one actor: an insert, delete or remove (an update that sets deleted_at) as one row with no field, and every changed field of an update as one row with its new value, named <prefix>.<column> for an extension. Restoring a row (deleted_at back to null) names deleted_at. Leaves out id, org_id and an extension''s key, kind and deleted_at, a column signed-in people cannot select and a Restricted column. Callers decide what a value means; nothing here leaves the database.';
revoke all on function private.audit_field_changes(text, uuid, timestamptz, uuid) from public, anon, authenticated;

create or replace function private.audit_changes_since(p_subject_table text, p_subject_id uuid, p_since timestamptz, p_skip_actor uuid,
  p_fields text[] default null)
returns table (
  change_kind text,
  fields text[],
  changed_at timestamptz,
  actor_person_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_added boolean;
  v_last_remove timestamptz;
  v_last_restore timestamptz;
  v_fields text[];
  v_changed_at timestamptz;
  v_actor uuid;
begin
  if p_subject_id is null or p_since is null then
    return;
  end if;
  select bool_or(c.operation = 'insert'),
         max(c.changed_at) filter (where c.operation in ('delete', 'remove')),
         max(c.changed_at) filter (where c.field = 'deleted_at'),
         coalesce(array_agg(distinct c.field order by c.field)
           filter (where c.field is not null and c.field <> 'deleted_at' and (p_fields is null or c.field = any (p_fields))), '{}'),
         max(c.changed_at)
    into v_added, v_last_remove, v_last_restore, v_fields, v_changed_at
  from private.audit_field_changes(p_subject_table, p_subject_id, p_since, p_skip_actor) c
  where c.field is null or c.field = 'deleted_at' or p_fields is null or c.field = any (p_fields);
  if v_changed_at is null then
    return;
  end if;
  select c.actor_person_id into v_actor
  from private.audit_field_changes(p_subject_table, p_subject_id, p_since, p_skip_actor) c
  where c.field is null or c.field = 'deleted_at' or p_fields is null or c.field = any (p_fields)
  order by c.changed_at desc, c.event_id desc
  limit 1;
  -- Removed wins over changed; a restore after the removal makes it a change of deleted_at.
  if v_last_remove is not null and (v_last_restore is null or v_last_remove > v_last_restore) then
    if coalesce(v_added, false) then
      return;
    end if;
    return query select 'removed'::text, '{}'::text[], v_changed_at, v_actor;
    return;
  end if;
  if v_last_restore is not null and (p_fields is null or 'deleted_at' = any (p_fields)) then
    v_fields := array(select distinct f from unnest(v_fields || 'deleted_at'::text) f order by f);
  end if;
  if coalesce(v_added, false) then
    return query select 'added'::text, v_fields, v_changed_at, v_actor;
    return;
  end if;
  if cardinality(v_fields) = 0 then
    return;
  end if;
  return query select 'changed'::text, v_fields, v_changed_at, v_actor;
end;
$$;

comment on function private.audit_changes_since(text, uuid, timestamptz, uuid, text[]) is 'B6 (ADR 0145): how one row changed strictly after an instant, from the ledger, leaving out one actor''s changes: added (an insert), removed (a delete, or deleted_at set, unless a later restore set it back) or changed, with the distinct fields that changed (private.audit_field_changes), limited to p_fields when given, plus the time and actor of the latest event. A row both added and removed returns nothing, as does a changed row left with no field. Never returns a value.';
revoke all on function private.audit_changes_since(text, uuid, timestamptz, uuid, text[]) from public, anon, authenticated;

create or replace function app.changes_since(p_subject_table text, p_subject_ids uuid[], p_since timestamptz)
returns table (
  subject_id uuid,
  change_kind text,
  fields text[],
  changed_at timestamptz,
  actor_person_id uuid,
  actor_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if p_subject_table is null or p_subject_table not in (select s.table_name from private.field_history_subjects s) then
    perform private.refuse('field_history_unavailable', 'This kind of row has no field history.');
  end if;
  if coalesce(cardinality(p_subject_ids), 0) > 200 then
    perform private.refuse('change_tracking_too_many', 'Ask for the changes of at most 200 rows at a time.');
  end if;
  if p_since is null or p_subject_ids is null then
    return;
  end if;
  return query
  with candidates as materialized (
    -- Rows with no event after the instant need no read check (audit_events_subject_idx).
    select distinct u.id
    from unnest(p_subject_ids) u(id)
    where u.id is not null
      and exists (select 1 from app.audit_events e where e.subject_id = u.id and e.created_at > p_since)
  ),
  readable as materialized (
    select c.id from candidates c where private.caller_reads_row(p_subject_table, c.id)
  )
  select r.id, x.change_kind, x.fields, x.changed_at, x.actor_person_id, p.full_name
  from readable r
  cross join lateral private.audit_changes_since(p_subject_table, r.id, p_since, v_person) x
  left join app.people p on p.id = x.actor_person_id
  order by x.changed_at desc;
end;
$$;

comment on function app.changes_since(text, uuid[], timestamptz) is 'B6 (ADR 0145): what others changed on up to 200 rows of a field history subject strictly after an instant, from the audit ledger: per row, added, removed or changed, the fields that changed (a record''s kind attributes as attributes.<column>), when and by whom. Rows the caller cannot read (their own read policies) are left out, as are the caller''s own changes. Never returns a value; a column signed-in people cannot select and a Restricted column never appear. Refuses field_history_unavailable for another table and change_tracking_too_many above 200 ids.';
revoke all on function app.changes_since(text, uuid[], timestamptz) from public, anon;
grant execute on function app.changes_since(text, uuid[], timestamptz) to authenticated, service_role;

-- 3. Seen marks -------------------------------------------------------------------------------------------------------------

create type app.seen_surface as enum ('Today', 'Itinerary', 'Show Day');
comment on type app.seen_surface is 'A page whose changes are marked since a person last looked (B6): Today (scope: the org), an engagement''s Itinerary in Gateway and Compass (scope: the engagement) and a project''s Show Day (scope: the project).';

create table app.seen_marks (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  surface app.seen_surface not null,
  scope_id uuid not null,
  baseline_at timestamptz,
  visit_started_at timestamptz not null,
  deleted_at timestamptz,
  constraint seen_marks_baseline_before_visit check (baseline_at is null or baseline_at <= visit_started_at)
);

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.seen_marks', 'Looking at a page of a canceled, read-only org still moves the person''s own last-seen marker.');

call private.install_domain_table('app.seen_marks');
create unique index seen_marks_scope_key on app.seen_marks (person_id, surface, scope_id) where deleted_at is null;

call private.describe('app.seen_marks', 'When a person last looked at a page whose changes are marked (B6, ADR 0145): Today, an engagement''s itinerary or a project''s Show day, once per page and scope. Only instants are kept; what changed is computed from the audit ledger. Only the person reads their own rows, and only the seen RPCs write them. Rows go after 90 days and when the person is deleted.', array[
  'org_id', 'Org that owns the scope: the org itself, the engagement''s or the project''s. Derived by the database.',
  'person_id', 'Person who looked; always the signed-in person.',
  'surface', 'Today, Itinerary or Show Day.',
  'scope_id', 'What was looked at: the org for Today, the engagement for Itinerary, the project for Show Day.',
  'baseline_at', 'The instant the page compares against: the start of the previous visit, or when the person marked all as seen. NULL before a second visit.',
  'visit_started_at', 'When the current visit started; a visit lasts 30 minutes.'
]);

create or replace function private.seen_scope_open(p_surface app.seen_surface, p_scope_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_scope_id is not null and case p_surface
    when 'Today' then p_scope_id in (select private.my_org_ids())
    when 'Itinerary' then p_scope_id in (select private.my_engagement_ids('operational'))
      or exists (
        select 1 from app.engagement_roster_entries r
        where r.engagement_id = p_scope_id and r.id in (select private.my_roster_entry_ids('operational')))
    when 'Show Day' then p_scope_id in (select private.project_ids_with('show.run_of_show.read'))
    else false
  end;
$$;

comment on function private.seen_scope_open(app.seen_surface, uuid) is 'B6: whether the signed-in person may keep a last-seen marker on a page''s scope: Today on an org they belong to; an Itinerary on an engagement whose operational area they reach (0710) or on whose roster they hold a live, accepted entry (R4, R8); Show Day on a project where they hold show.run_of_show.read.';
revoke all on function private.seen_scope_open(app.seen_surface, uuid) from public, anon, authenticated;

create or replace function private.seen_scope_org(p_surface app.seen_surface, p_scope_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_surface
    when 'Today' then (select o.id from app.organizations o where o.id = p_scope_id)
    when 'Itinerary' then (select e.org_id from app.engagements e where e.id = p_scope_id)
    when 'Show Day' then (select p.org_id from app.projects p where p.id = p_scope_id)
  end;
$$;

comment on function private.seen_scope_org(app.seen_surface, uuid) is 'B6: the org that owns a seen mark''s scope: the org itself for Today, the engagement''s producing org for an Itinerary, the project''s org for Show Day.';
revoke all on function private.seen_scope_org(app.seen_surface, uuid) from public, anon, authenticated;

create or replace function private.guard_seen_mark()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if tg_op = 'UPDATE' and (new.person_id <> old.person_id or new.surface <> old.surface or new.scope_id <> old.scope_id) then
    perform private.refuse('seen_mark_immutable', 'A seen mark keeps its person, page and scope; only its instants change.');
  end if;
  if auth.uid() is not null then
    -- An itinerary's marks belong to external parties under the producing org, so no membership is asked for: the
    -- scope must be open to the person instead.
    if v_person is null or not private.seen_scope_open(new.surface, new.scope_id) then
      raise exception using errcode = '42501', message = 'the page is not available to you';
    end if;
    new.person_id := v_person;
  end if;
  new.org_id := private.seen_scope_org(new.surface, new.scope_id);
  return new;
end;
$$;

comment on function private.guard_seen_mark() is 'Seen marks: kept for the signed-in person only, on a scope open to them (private.seen_scope_open), under the org that owns the scope; the person, page and scope never change.';
revoke all on function private.guard_seen_mark() from public, anon, authenticated;

create trigger t05_guard_seen_mark before insert or update on app.seen_marks
  for each row execute function private.guard_seen_mark();

create or replace function private.forget_seen_marks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app.seen_marks m where m.person_id = new.id;
  return null;
end;
$$;

comment on function private.forget_seen_marks() is 'Deletes a person''s seen marks when the person is deleted (app.delete_my_account soft-deletes app.people), so no trace of when they looked outlives them.';
revoke all on function private.forget_seen_marks() from public, anon, authenticated;

create trigger t91_forget_seen_marks after update of deleted_at on app.people
  for each row when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.forget_seen_marks();

call private.install_policies('app.seen_marks', $$person_id = (select private.current_person_id())$$);

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.seen_marks', 'Age', 'visit_started_at', interval '90 days', 'Delete', 'When a person last looked at a page; after three months without a visit every change would be new anyway.');

create or replace function private.effective_seen_baseline(p_baseline_at timestamptz, p_visit_started_at timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case when now() - p_visit_started_at >= interval '30 minutes' then p_visit_started_at else p_baseline_at end;
$$;

comment on function private.effective_seen_baseline(timestamptz, timestamptz) is 'B6 (ADR 0145): the instant a page compares against. A visit is a 30-minute window: once 30 minutes have passed since the current visit started, the next visit compares against that start; until then, against the stored baseline.';
revoke all on function private.effective_seen_baseline(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function app.seen_baseline(p_surface app.seen_surface, p_scope_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if not private.seen_scope_open(p_surface, p_scope_id) then
    raise exception using errcode = '42501', message = 'the page is not available to you';
  end if;
  return (
    select private.effective_seen_baseline(m.baseline_at, m.visit_started_at)
    from app.seen_marks m
    where m.person_id = v_person and m.surface = p_surface and m.scope_id = p_scope_id and m.deleted_at is null);
end;
$$;

comment on function app.seen_baseline(app.seen_surface, uuid) is 'B6 (ADR 0145): the instant the signed-in person''s page compares against, without recording a visit, so a server render shows what the visit will commit; equal to what app.record_visit then returns. NULL on a first visit. 42501 when the scope is not open to the person.';
revoke all on function app.seen_baseline(app.seen_surface, uuid) from public, anon;
grant execute on function app.seen_baseline(app.seen_surface, uuid) to authenticated, service_role;

create or replace function app.record_visit(p_surface app.seen_surface, p_scope_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_mark app.seen_marks;
begin
  if not private.seen_scope_open(p_surface, p_scope_id) then
    raise exception using errcode = '42501', message = 'the page is not available to you';
  end if;
  insert into app.seen_marks (person_id, surface, scope_id, baseline_at, visit_started_at)
  values (v_person, p_surface, p_scope_id, null, now())
  on conflict (person_id, surface, scope_id) where deleted_at is null do nothing;
  if found then
    return null;
  end if;
  select * into v_mark from app.seen_marks m
  where m.person_id = v_person and m.surface = p_surface and m.scope_id = p_scope_id and m.deleted_at is null
  for update;
  if now() - v_mark.visit_started_at >= interval '30 minutes' then
    update app.seen_marks set baseline_at = v_mark.visit_started_at, visit_started_at = now() where id = v_mark.id;
    return v_mark.visit_started_at;
  end if;
  return v_mark.baseline_at;
end;
$$;

comment on function app.record_visit(app.seen_surface, uuid) is 'B6 (ADR 0145): records that the signed-in person opened a page and returns the instant it compares against. A first visit keeps no baseline (NULL); a visit 30 minutes or more after the previous one started makes that start the baseline; a visit within the window changes nothing, so a refresh never clears the highlights. 42501 when the scope is not open to the person.';
revoke all on function app.record_visit(app.seen_surface, uuid) from public, anon;
grant execute on function app.record_visit(app.seen_surface, uuid) to authenticated, service_role;

create or replace function app.mark_seen(p_surface app.seen_surface, p_scope_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if not private.seen_scope_open(p_surface, p_scope_id) then
    raise exception using errcode = '42501', message = 'the page is not available to you';
  end if;
  insert into app.seen_marks (person_id, surface, scope_id, baseline_at, visit_started_at)
  values (v_person, p_surface, p_scope_id, now(), now())
  on conflict (person_id, surface, scope_id) where deleted_at is null
  do update set baseline_at = excluded.baseline_at, visit_started_at = excluded.visit_started_at;
  return now();
end;
$$;

comment on function app.mark_seen(app.seen_surface, uuid) is 'B6 (ADR 0145): Mark all as seen. Moves the signed-in person''s baseline and visit start on a page to now and returns it. 42501 when the scope is not open to the person.';
revoke all on function app.mark_seen(app.seen_surface, uuid) from public, anon;
grant execute on function app.mark_seen(app.seen_surface, uuid) to authenticated, service_role;

-- 4. Today: changes since the last visit -------------------------------------------------------------------------------------

create or replace function app.today_changes(p_org_id uuid, p_limit integer default 20)
returns table (
  subject_table text,
  subject_id uuid,
  subject_key text,
  title text,
  project_key text,
  change_kind text,
  fields text[],
  changed_at timestamptz,
  actor_person_id uuid,
  actor_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_since timestamptz := app.seen_baseline('Today', p_org_id);
begin
  if v_since is null then
    return;
  end if;
  return query
  with candidates as materialized (
    select 'app.records'::text as subject_table, r.id
    from app.records r
    where r.org_id = p_org_id and r.deleted_at is null
      and (exists (select 1 from app.record_assignments a join app.memberships m on m.id = a.membership_id
                   where a.record_id = r.id and a.deleted_at is null and m.person_id = v_person)
        or exists (select 1 from app.record_watchers w where w.record_id = r.id and w.deleted_at is null and w.person_id = v_person))
      and exists (select 1 from app.audit_events e where e.subject_id = r.id and e.created_at > v_since)
    union all
    select 'app.shifts', s.id
    from app.shifts s
    where s.org_id = p_org_id and s.deleted_at is null
      and s.ends_at > now() - interval '1 day' and s.starts_at < now() + interval '14 days'
      and private.shift_worker_person_id(s.membership_id, s.engagement_id) = v_person
      and exists (select 1 from app.audit_events e where e.subject_id = s.id and e.created_at > v_since)
  ),
  readable as materialized (
    select c.subject_table, c.id from candidates c where private.caller_reads_row(c.subject_table, c.id)
  )
  select r.subject_table, r.id,
         case when r.subject_table = 'app.records' then pr.project_key || '-' || rec.record_number::text end,
         case when r.subject_table = 'app.records' then rec.title else private.shift_notification_title(r.id) end,
         pr.project_key,
         x.change_kind, x.fields, x.changed_at, x.actor_person_id, p.full_name
  from readable r
  cross join lateral private.audit_changes_since(r.subject_table, r.id, v_since, v_person) x
  left join app.records rec on r.subject_table = 'app.records' and rec.id = r.id
  left join app.shifts sh on r.subject_table = 'app.shifts' and sh.id = r.id
  left join app.projects pr on pr.id = coalesce(rec.project_id, sh.project_id)
  left join app.people p on p.id = x.actor_person_id
  order by x.changed_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
end;
$$;

comment on function app.today_changes(uuid, integer) is 'B6 (G-249, ADR 0145): the Since your last visit tile of Home > Today. What others changed, after the signed-in person''s Today baseline (app.seen_baseline), on the live records of the org they are assigned to or watch and on their own live shifts ending after yesterday and starting within 14 days: per row the change kind, the fields, when, by whom, and the record''s key and title or the shift''s notification title. Newest first, at most 50 rows. No rows before a baseline exists; rows the person cannot read are left out. Never returns a value.';
revoke all on function app.today_changes(uuid, integer) from public, anon;
grant execute on function app.today_changes(uuid, integer) to authenticated, service_role;
