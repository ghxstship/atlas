-- 2951_communication_marks.sql
--
-- B6 (RRR-230, G-120; ADR 0145). A coordinator who changes a published shift needs to know whether the person on it
-- has been told. 1394 already tells the worker when a published shift is assigned to them (shift.assigned) or its
-- times move (shift.changed); a change to the role, the scope node, the record, the zone, the break, a cancellation or
-- a return to Draft goes out unannounced. An assignee counts as told at the latest of three instants:
--   * a communication mark: a coordinator says they told the person (Mark as communicated);
--   * the person's own acceptance of the shift (0460);
--   * a notification of a telling kind about the shift that reached them: not archived when it was created (In App
--     on), or with an Email, SMS or Push delivery Sent or Delivered.
-- What changed since then is computed from the ledger (2950), never stored, and the changes the assignee made
-- themselves are left out. A shift needs review when it is live, has an assignee and ends after now, and either it is
-- Published or Accepted with a communicable change after that instant or with no such instant at all, or it was
-- canceled or returned to Draft after it.
--
-- An event at exactly the told instant counts as told: one update can save several fields at once. A shift.changed
-- notification tells only the times, so a role saved in the same update as a new start still counts as a change.
--
-- Known limits (ADR 0145): a Published shift soft-deleted from the trash leaves Needs review, which covers live shifts
-- only; the person a reassigned shift was taken from is never told (1394 has no kind for it); a deleted shift cannot be
-- marked as communicated.

-- 1. Registry ------------------------------------------------------------------------------------------------------------

create table private.communication_subjects (
  table_name text primary key references private.field_history_subjects (table_name),
  read_capability text not null references app.capabilities (code),
  write_capability text not null references app.capabilities (code)
);

create index communication_subjects_read_capability_idx on private.communication_subjects (read_capability);
create index communication_subjects_write_capability_idx on private.communication_subjects (write_capability);

comment on table private.communication_subjects is 'Tables whose rows have an assignee who is told of changes (B6, ADR 0145): Needs review and Mark as communicated. Each is a field history subject, whose ledger the changes come from.';
comment on column private.communication_subjects.table_name is 'Schema-qualified table.';
comment on column private.communication_subjects.read_capability is 'Capability on the row''s project that reads its communication marks.';
comment on column private.communication_subjects.write_capability is 'Capability on the row''s project that reads its communication status and marks it as communicated.';

create table private.communication_fields (
  table_name text not null references private.communication_subjects (table_name),
  field_name text not null,
  new_value_pattern text,
  timing boolean not null default false,
  primary key (table_name, field_name)
);

comment on table private.communication_fields is 'The fields of a communication subject whose change the assignee must be told of (B6).';
comment on column private.communication_fields.table_name is 'Communication subject.';
comment on column private.communication_fields.field_name is 'Column whose change counts.';
comment on column private.communication_fields.new_value_pattern is 'Regular expression the new value must match for the change to count, such as a cancellation; NULL when every change counts.';
comment on column private.communication_fields.timing is 'True for the times a timing-only notification tells (a shift''s start, end and zone).';

create table private.communication_telling_kinds (
  table_name text not null references private.communication_subjects (table_name),
  kind text not null,
  timing_only boolean not null default false,
  primary key (table_name, kind)
);

comment on table private.communication_telling_kinds is 'Notification kinds that tell an assignee about a row of a communication subject (B6). Each is a kind of private.notification_templates.';
comment on column private.communication_telling_kinds.table_name is 'Communication subject.';
comment on column private.communication_telling_kinds.kind is 'Notification kind.';
comment on column private.communication_telling_kinds.timing_only is 'True when the kind tells only the times (shift.changed): a change saved in the same instant to any other field still counts.';

alter table private.communication_subjects enable row level security;
alter table private.communication_fields enable row level security;
alter table private.communication_telling_kinds enable row level security;
revoke all on private.communication_subjects, private.communication_fields, private.communication_telling_kinds
  from public, anon, authenticated;
grant select on private.communication_subjects, private.communication_fields, private.communication_telling_kinds to service_role;

insert into private.communication_subjects (table_name, read_capability, write_capability) values
  ('app.shifts', 'crew.shift.read', 'crew.shift.write');

insert into private.communication_fields (table_name, field_name, new_value_pattern, timing) values
  ('app.shifts', 'starts_at', null, true),
  ('app.shifts', 'ends_at', null, true),
  ('app.shifts', 'time_zone', null, true),
  ('app.shifts', 'role_code', null, false),
  ('app.shifts', 'scope_node_id', null, false),
  ('app.shifts', 'record_id', null, false),
  ('app.shifts', 'membership_id', null, false),
  ('app.shifts', 'engagement_id', null, false),
  ('app.shifts', 'scheduled_break_minutes', null, false),
  ('app.shifts', 'shift_state', '^(Canceled|Draft)$', false);

insert into private.communication_telling_kinds (table_name, kind, timing_only) values
  ('app.shifts', 'shift.assigned', false),
  ('app.shifts', 'shift.changed', true);

create or replace function private.shift_assignee(p_shift_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.shift_worker_person_id(s.membership_id, s.engagement_id) from app.shifts s where s.id = p_shift_id;
$$;

comment on function private.shift_assignee(uuid) is 'B6: the person on a shift now, the member or the engaged worker (private.shift_worker_person_id, 1394); NULL for an open shift.';
revoke all on function private.shift_assignee(uuid) from public, anon, authenticated;

-- 2. Communication marks ---------------------------------------------------------------------------------------------------

create table app.communication_marks (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  subject_table text not null,
  subject_id uuid not null,
  person_id uuid not null references app.people (id),
  note text,
  deleted_at timestamptz,
  constraint communication_marks_subject_table check (subject_table ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint communication_marks_note_length check (note is null or char_length(btrim(note)) between 1 and 300)
);

call private.install_domain_table('app.communication_marks', null, null, array['app.projects', 'project_id'], true);

create index communication_marks_subject_idx on app.communication_marks (subject_id, person_id, created_at desc);
create index communication_marks_project_id_idx on app.communication_marks (project_id);
create index communication_marks_person_id_idx on app.communication_marks (person_id);

call private.describe('app.communication_marks', 'A coordinator''s word that they told the person on a row about it (B6, Mark as communicated): one append-only mark per row and assignee, at the instant it was saved (created_at), by whom (created_by). Changes after the latest mark, acceptance or notification need review. Written only by app.mark_communicated; never updated or deleted.', array[
  'org_id', 'Org of the row, stamped from it by app.mark_communicated; never accepted from the caller.',
  'project_id', 'Project of the row, stamped from it by app.mark_communicated; never accepted from the caller.',
  'subject_table', 'Table of the row, a communication subject such as app.shifts.',
  'subject_id', 'Row the person was told about.',
  'person_id', 'Person who was told: the row''s assignee when the mark was saved.',
  'note', 'How the person was told, such as a phone call; 1 to 300 characters.'
]);

call private.install_audit_trail('app.communication_marks');

call private.install_policies('app.communication_marks',
  $$subject_table = 'app.shifts' and project_id in (select private.project_ids_with('crew.shift.read'))$$);

call private.install_default_retention('app.communication_marks');

-- Notifications about a row for a person, for private.last_told. On the partitioned parent it builds on every partition.
create index notifications_subject_recipient_idx on app.notifications (subject_id, recipient_person_id) where subject_id is not null;

-- 3. When an assignee was last told ------------------------------------------------------------------------------------------

create or replace function private.last_told(p_subject_table text, p_subject_id uuid, p_person_id uuid)
returns table (
  told_at timestamptz,
  told_via text,
  told_by uuid,
  told_kind text
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.told_at, t.told_via, t.told_by, t.told_kind
  from (
    select m.created_at as told_at, 'marked'::text as told_via, m.created_by as told_by, null::text as told_kind, 1 as tie
    from app.communication_marks m
    where m.subject_id = p_subject_id and m.person_id = p_person_id and m.subject_table = p_subject_table
      and m.deleted_at is null
    union all
    select x.created_at, 'accepted', x.created_by, null, 2
    from app.shift_state_transitions x
    where p_subject_table = 'app.shifts' and x.shift_id = p_subject_id and x.to_state = 'Accepted'
      and x.created_by = p_person_id
    union all
    -- A timing-only kind sorts before one that tells everything at the same instant, so a change saved with the
    -- times still counts.
    select n.created_at, 'notified', n.actor_person_id, n.kind, case when k.timing_only then 3 else 4 end
    from app.notifications n
    join private.communication_telling_kinds k on k.table_name = p_subject_table and k.kind = n.kind
    where n.subject_id = p_subject_id and n.recipient_person_id = p_person_id and n.subject_table = p_subject_table
      and (n.archived_at is null or n.archived_at > n.created_at
        or exists (
          select 1 from app.notification_deliveries d
          where d.notification_id = n.id and d.notification_created_at = n.created_at
            and d.message_status in ('Sent', 'Delivered')))
  ) t
  where p_person_id is not null
  order by t.told_at desc, t.tie
  limit 1;
$$;

comment on function private.last_told(text, uuid, uuid) is 'B6 (ADR 0145): when a person was last told about a row, the latest of: a live communication mark (marked, by its author), their own acceptance of the shift (accepted) and a notification of a telling kind about the row that reached them, not archived at creation (In App on) or with a delivery Sent or Delivered (notified, by its actor, with its kind). NULL when none.';
revoke all on function private.last_told(text, uuid, uuid) from public, anon, authenticated;

create or replace function app.communication_status(p_subject_table text, p_subject_ids uuid[])
returns table (
  subject_id uuid,
  person_id uuid,
  person_name text,
  told_at timestamptz,
  told_via text,
  told_by_name text,
  changed_at timestamptz,
  changed_fields text[],
  needs_review boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject private.communication_subjects;
begin
  perform private.require_person();
  select * into v_subject from private.communication_subjects s where s.table_name = p_subject_table;
  if not found or p_subject_table <> 'app.shifts' then
    perform private.refuse('communication_unavailable', 'This kind of row has no communication status.');
  end if;
  if coalesce(cardinality(p_subject_ids), 0) > 500 then
    perform private.refuse('communication_too_many', 'Ask for the communication status of at most 500 rows at a time.');
  end if;
  if p_subject_ids is null then
    return;
  end if;
  return query
  with writable as materialized (
    select s.id, s.shift_state, s.ends_at, s.deleted_at, private.shift_assignee(s.id) as assignee
    from app.shifts s
    where s.id in (select distinct u.id from unnest(p_subject_ids) u(id))
      and s.project_id in (select private.project_ids_with(v_subject.write_capability))
  ),
  readable as materialized (
    select w.* from writable w where private.caller_reads_row(p_subject_table, w.id)
  ),
  told as (
    select r.*, t.told_at, t.told_via, t.told_by, coalesce(k.timing_only, false) as timing_only
    from readable r
    left join lateral private.last_told(p_subject_table, r.id, r.assignee) t on true
    left join private.communication_telling_kinds k on k.table_name = p_subject_table and k.kind = t.told_kind
  ),
  changes as (
    select t.id, max(c.changed_at) as changed_at, array_agg(distinct c.field order by c.field) as fields
    from told t
    cross join lateral private.audit_field_changes(p_subject_table, t.id, t.told_at - interval '1 microsecond', t.assignee) c
    join private.communication_fields f on f.table_name = p_subject_table and f.field_name = c.field
    where t.told_at is not null
      and (c.changed_at > t.told_at or (t.timing_only and not f.timing))
      and (f.new_value_pattern is null or coalesce(c.new_value #>> '{}', '') ~ f.new_value_pattern)
    group by t.id
  )
  select t.id, t.assignee, p.full_name, t.told_at, t.told_via, b.full_name, c.changed_at, coalesce(c.fields, '{}'::text[]),
    t.deleted_at is null and t.assignee is not null and t.ends_at > now()
      and ((t.shift_state in ('Published', 'Accepted') and (t.told_at is null or c.fields is not null))
        or (t.shift_state in ('Canceled', 'Draft') and 'shift_state' = any (coalesce(c.fields, '{}'::text[]))))
  from told t
  left join changes c on c.id = t.id
  left join app.people p on p.id = t.assignee
  left join app.people b on b.id = t.told_by;
end;
$$;

comment on function app.communication_status(text, uuid[]) is 'B6 (G-120, ADR 0145): for up to 500 rows of a communication subject (app.shifts), the person on each, when and how they were last told (marked, accepted or notified, private.last_told) and by whom, the communicable fields others changed after that instant (from the ledger; a cancellation or a return to Draft as shift_state), and whether the row needs review: live, with an assignee, ending after now, and Published or Accepted with such a change or never told, or canceled or returned to Draft after being told. Only rows the caller reads and holds the subject''s write capability on. Refuses communication_unavailable and communication_too_many.';
revoke all on function app.communication_status(text, uuid[]) from public, anon;
grant execute on function app.communication_status(text, uuid[]) to authenticated, service_role;

create or replace function app.mark_communicated(p_subject_table text, p_subject_ids uuid[], p_note text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subject private.communication_subjects;
  v_ids uuid[];
  v_count integer;
begin
  perform private.require_person();
  select * into v_subject from private.communication_subjects s where s.table_name = p_subject_table;
  if not found or p_subject_table <> 'app.shifts' then
    perform private.refuse('communication_unavailable', 'This kind of row has no communication status.');
  end if;
  if coalesce(cardinality(p_subject_ids), 0) > 500 then
    perform private.refuse('communication_too_many', 'Mark at most 500 rows as communicated at a time.');
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 300 then
    perform private.refuse('communication_note_length', 'A note on how the person was told is at most 300 characters.');
  end if;
  v_ids := array(select distinct u.id from unnest(p_subject_ids) u(id) where u.id is not null);
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  -- All or nothing: every row must be the caller's to write.
  if exists (
    select 1 from unnest(v_ids) u(id)
    left join app.shifts s on s.id = u.id
    where s.id is null or not private.can_on_project(s.project_id, v_subject.write_capability)
  ) then
    raise exception using errcode = '42501', message = 'a row is not available to you';
  end if;
  if exists (
    select 1 from app.shifts s
    where s.id = any (v_ids) and (s.deleted_at is not null or private.shift_assignee(s.id) is null)
  ) then
    perform private.refuse('communication_no_assignee', 'Only a live shift with a person on it can be marked as communicated.');
  end if;
  insert into app.communication_marks (org_id, project_id, subject_table, subject_id, person_id, note)
  select s.org_id, s.project_id, p_subject_table, s.id, private.shift_assignee(s.id), nullif(btrim(p_note), '')
  from app.shifts s
  where s.id = any (v_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.mark_communicated(text, uuid[], text) is 'B6 (G-120, ADR 0145): Mark as communicated. Saves one communication mark for each of up to 500 rows, for the person on it now, at the same instant, with an optional note; org and project come from the row. All or nothing: 42501 unless the caller holds the subject''s write capability on every row''s project, communication_no_assignee for a deleted or open row, communication_too_many above 500 ids. Returns the number of marks.';
revoke all on function app.mark_communicated(text, uuid[], text) from public, anon;
grant execute on function app.mark_communicated(text, uuid[], text) to authenticated, service_role;
