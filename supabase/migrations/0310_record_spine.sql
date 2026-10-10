-- 0310_record_spine.sql
-- A03 Domain Data. The record spine (Section 3.10, Section 7.4 Record spine): one records table for
-- all 26 kinds with the kind-scoped subtype composite foreign key, title grammar validated on write,
-- the nine record states (Blocked names its blocker, Deferred carries a replan reason, Canceled is
-- retained), the append-only state ledger and replan log (replans logged from Scheduled onward),
-- checklist items, dependencies, recurrences, watchers, assignments and external visibility as
-- junction tables. Kind extension tables follow in 0311.
--
-- Invariant 2: a record is readable by members of its project holding work.record.read, by project
-- oversight, and by the people assigned to it (owner, accountable party, assignees), not the org.
-- record_class is not stored: it is a fact of the kind (Section 3.15), read through app.record_class.

-- Installer fix: tables keyed by another column (1:1 extensions) have no id column -------------------

create or replace procedure private.install_domain_table(
  p_table regclass,
  p_parent_table text default null,
  p_parent_column text default null,
  p_references text[] default '{}',
  p_ledger boolean default false
)
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
  v_id_attnum smallint := (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = 'id' and not a.attisdropped);
  v_org_attnum smallint := (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = p_table and a.attname = 'org_id' and not a.attisdropped);
begin
  execute format('alter table %s add column if not exists created_at timestamptz not null default now()', p_table);
  execute format('alter table %s add column if not exists created_by uuid references app.people (id)', p_table);
  execute format('alter table %s add column if not exists updated_at timestamptz not null default now()', p_table);
  execute format('alter table %s add column if not exists updated_by uuid references app.people (id)', p_table);
  execute format('alter table %s add column if not exists deleted_at timestamptz', p_table);

  if v_id_attnum is not null and col_description(p_table, v_id_attnum) is null then
    execute format('comment on column %s.id is %L', p_table, 'Primary key, UUID v7.');
  end if;
  if p_parent_table is not null then
    execute format('comment on column %s.org_id is %L', p_table,
      format('Owning org, derived from %s on insert; never accepted from the caller and never changed.', p_parent_table));
  elsif col_description(p_table, v_org_attnum) is null then
    execute format('comment on column %s.org_id is %L', p_table, 'Owning org. A row never moves to another org.');
  end if;

  execute format('create index if not exists %I on %s (org_id)', v_name || '_org_id_idx', p_table);
  call private.install_audit_columns(p_table);
  call private.install_tenant_guards(p_table, p_parent_table, p_parent_column, p_references);

  if p_ledger then
    execute format('drop trigger if exists t95_append_only on %s', p_table);
    execute format(
      'create trigger t95_append_only before update or delete on %s for each row execute function private.refuse_ledger_change()',
      p_table);
  end if;

  execute format('alter table %s enable row level security', p_table);
  execute format('revoke all on %s from public, anon, authenticated', p_table);
  execute format('grant select on %s to authenticated', p_table);
  execute format('grant all on %s to service_role', p_table);
end;
$$;

revoke all on procedure private.install_domain_table(regclass, text, text, text[], boolean) from public, anon, authenticated;

-- Canon enumeration values -----------------------------------------------------------------------------
-- Columns that store a canon enumeration value (Bible enumerations sheet) reference its row and are
-- checked to belong to the right enumeration domain, so no list is retyped here.

create or replace function private.assert_enumeration(p_record_id text, p_domain text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_record_id is not null and not exists (
    select 1 from xpms.std_enumeration e where e.record_id = p_record_id and e.enum_domain = p_domain
  ) then
    perform private.refuse('enumeration_domain', format('%s is not a %s value.', p_record_id, p_domain));
  end if;
end;
$$;

comment on function private.assert_enumeration(text, text) is 'Refuses a canon enumeration row that is not in the expected enumeration domain.';
revoke all on function private.assert_enumeration(text, text) from public, anon, authenticated;

-- Enums -----------------------------------------------------------------------------------------------

create type app.xyz_basis as enum ('Category', 'Declared');
comment on type app.xyz_basis is 'Why a row carries its XYZ tag (Section 3.6): inherited from its URID category, or declared for the row.';

create type app.dependency_type as enum ('Finish to Start', 'Start to Start', 'Finish to Finish', 'Start to Finish');
comment on type app.dependency_type is 'Schedule dependency types between two records.';

create type app.external_role_type as enum (
  'Client', 'Vendor', 'Contractor', 'Crew', 'Staff', 'Artist', 'Artist Representative', 'Sponsor'
);
comment on type app.external_role_type is 'External role types (Section 8): they come from engagements and never grant Atlas access.';

create type app.money_direction as enum ('Payable', 'Receivable');
comment on type app.money_direction is 'Whether money flows out to a counterparty (Payable) or in from one (Receivable).';

create type app.approval_decision as enum ('Approved', 'Rejected');
comment on type app.approval_decision is 'Outcome of an approval decided by an eligible approver.';

-- Record lifecycle rules (Bible tab 26 states) -------------------------------------------------------------

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('record', 'Proposed', 'Ready'),
  ('record', 'Proposed', 'Scheduled'),
  ('record', 'Proposed', 'Deferred'),
  ('record', 'Proposed', 'Canceled'),
  ('record', 'Ready', 'Proposed'),
  ('record', 'Ready', 'Scheduled'),
  ('record', 'Ready', 'Active'),
  ('record', 'Ready', 'Blocked'),
  ('record', 'Ready', 'Deferred'),
  ('record', 'Ready', 'Canceled'),
  ('record', 'Scheduled', 'Ready'),
  ('record', 'Scheduled', 'Active'),
  ('record', 'Scheduled', 'Blocked'),
  ('record', 'Scheduled', 'Deferred'),
  ('record', 'Scheduled', 'Canceled'),
  ('record', 'Active', 'Blocked'),
  ('record', 'Active', 'In Review'),
  ('record', 'Active', 'Complete'),
  ('record', 'Active', 'Deferred'),
  ('record', 'Active', 'Canceled'),
  ('record', 'Blocked', 'Ready'),
  ('record', 'Blocked', 'Scheduled'),
  ('record', 'Blocked', 'Active'),
  ('record', 'Blocked', 'Deferred'),
  ('record', 'Blocked', 'Canceled'),
  ('record', 'In Review', 'Active'),
  ('record', 'In Review', 'Complete'),
  ('record', 'In Review', 'Canceled'),
  ('record', 'Complete', 'Active'),
  ('record', 'Deferred', 'Proposed'),
  ('record', 'Deferred', 'Ready'),
  ('record', 'Deferred', 'Scheduled'),
  ('record', 'Deferred', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('record.created', 'records', 'A record of any kind was created.'),
  ('record.state_changed', 'records', 'A record moved to another record state.'),
  ('record.replanned', 'records', 'A record from Scheduled onward changed its dates or state, and the replan was logged.');

-- Subject events -------------------------------------------------------------------------------------------
-- Ledger rows describe a change to another row (the subject). Arguments: event type, subject table
-- (in app), subject column of the ledger row, then the columns copied into the payload. The project
-- comes from the subject's project_id column, or is the subject itself when the subject is a project.

create or replace function private.emit_subject_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_subject uuid := (v_row ->> tg_argv[2])::uuid;
  v_project uuid;
  v_data jsonb := '{}'::jsonb;
  i integer := 3;
begin
  if tg_argv[1] = 'projects' then
    v_project := v_subject;
  elsif exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = ('app.' || tg_argv[1])::regclass and a.attname = 'project_id' and not a.attisdropped) then
    execute format('select project_id from app.%I where id = $1', tg_argv[1]) into v_project using v_subject;
  end if;
  while i < tg_nargs loop
    v_data := v_data || jsonb_build_object(tg_argv[i], v_row -> tg_argv[i]);
    i := i + 1;
  end loop;
  perform private.emit_event(new.org_id, tg_argv[0], tg_argv[1], v_subject, v_project, v_data);
  return null;
end;
$$;

comment on function private.emit_subject_event() is 'After insert trigger on ledgers: emits a domain event about the ledger''s subject row. Arguments: event type, subject table, subject column, then payload columns.';
revoke all on function private.emit_subject_event() from public, anon, authenticated;

drop trigger t90_emit_project_state on app.project_state_transitions;
create trigger t90_emit_project_state after insert on app.project_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('project.state_changed', 'projects', 'project_id', 'from_state', 'to_state', 'reason');
drop trigger t90_emit_production_state on app.production_state_transitions;
create trigger t90_emit_production_state after insert on app.production_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('project.production_state_changed', 'projects', 'project_id', 'from_state', 'to_state', 'reason');
drop trigger t90_emit_gate_passed on app.project_phase_transitions;
create trigger t90_emit_gate_passed after insert on app.project_phase_transitions
  for each row execute function private.emit_subject_event('project.gate_passed', 'projects', 'project_id', 'gate', 'from_phase_code', 'to_phase_code');

-- Records -------------------------------------------------------------------------------------------------

create table app.records (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  record_number bigint not null default 0,
  record_kind text not null references xpms.dim_record_kind (record_kind),
  record_subtype text,
  record_state text not null default 'Proposed' references xpms.dim_record_state (record_state),
  title text not null,
  phase_code text references xpms.dim_phase (phase_code),
  urid text references xpms.dim_category (cat_urid),
  xyz xpms.xyz_tag not null,
  xyz_basis app.xyz_basis not null,
  owner_party_id uuid references app.people (id),
  accountable_party_id uuid references app.people (id),
  starts_at timestamptz,
  ends_at timestamptz,
  due_at timestamptz,
  time_zone text,
  blocker_text text,
  replan_reason text,
  deleted_at timestamptz,
  constraint records_kind_subtype_fkey foreign key (record_kind, record_subtype)
    references xpms.dim_record_subtype (record_kind, record_subtype),
  constraint records_id_kind_key unique (id, record_kind),
  constraint records_title_length check (char_length(btrim(title)) between 1 and 200 and title = btrim(title)),
  constraint records_window check (ends_at is null or starts_at is null or ends_at >= starts_at),
  constraint records_blocked_names_blocker check (
    record_state <> 'Blocked' or (blocker_text is not null and char_length(btrim(blocker_text)) > 0)),
  constraint records_deferred_carries_reason check (
    record_state <> 'Deferred' or (replan_reason is not null and char_length(btrim(replan_reason)) > 0)),
  constraint records_xyz_basis_needs_urid check (xyz_basis <> 'Category' or urid is not null)
);

create index records_project_id_idx on app.records (project_id, record_number);
create unique index records_project_number_key on app.records (project_id, record_number);
create index records_scope_node_id_idx on app.records (scope_node_id);
create index records_record_kind_idx on app.records (record_kind, record_subtype);
create index records_record_state_idx on app.records (record_state);
create index records_phase_code_idx on app.records (phase_code);
create index records_urid_idx on app.records (urid);
create index records_owner_party_id_idx on app.records (owner_party_id);
create index records_accountable_party_id_idx on app.records (accountable_party_id);

call private.install_domain_table('app.records', 'app.projects', 'project_id', array['app.scope_nodes', 'scope_node_id']);
call private.describe('app.records', 'One table for all 26 record kinds (Bible tab 24, Section 3.10). Kind attributes live in 1:1 extension tables. A record is readable by its project''s members and the people assigned to it, not the whole org (invariant 2). Canceled records are retained, never deleted.', array[
  'project_id', 'Project the record belongs to. Never changes.',
  'scope_node_id', 'Scope node of the same project the record sits under.',
  'record_number', 'Sequence number within the project, issued by private.next_sequence on insert. The display key is {project_key}-{record_number}, read through app.record_display_key.',
  'record_kind', 'One of the 26 canon record kinds. Never changes after insert.',
  'record_subtype', 'Kind-scoped subtype (Bible tab 25). The composite foreign key with record_kind refuses a subtype of another kind.',
  'record_state', 'One of the nine record states (Bible tab 26). Changes only through app.transition_record.',
  'title', 'Title in the kind''s title grammar, validated on write with a correction message.',
  'phase_code', 'Gated phase the record belongs to.',
  'urid', 'URID category the record works on (dimension 2).',
  'xyz', 'XYZ schema-family tag: X Resource, Y Process, Z Timeline.',
  'xyz_basis', 'Basis of the XYZ tag: Category (equals the URID category''s tag) or Declared.',
  'owner_party_id', 'Person who owns the record and does the work.',
  'accountable_party_id', 'Person accountable for the record''s outcome.',
  'starts_at', 'Start of the record''s window.',
  'ends_at', 'End of the record''s window; not before starts_at.',
  'due_at', 'When the record is due.',
  'time_zone', 'IANA zone the record''s local times were typed in; NULL means the project''s zone.',
  'blocker_text', 'What blocks the record. Required while the record is Blocked.',
  'replan_reason', 'Why the record was replanned. Required while the record is Deferred.'
]);

-- Title grammar ----------------------------------------------------------------------------------------------
-- The grammar class comes from the canon title_grammar text of the kind (Bible tab 24), so the rule is
-- never restated here; this function only knows how to check each class and phrase the correction.

create or replace function private.title_grammar_refusal(p_kind text, p_title text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_grammar text := (select k.title_grammar from xpms.dim_record_kind k where k.record_kind = p_kind);
  v_words text[] := regexp_split_to_array(btrim(p_title), '\s+');
  v_first text := lower(regexp_replace(v_words[1], '[^A-Za-z-]', '', 'g'));
  v_word text;
  v_small constant text[] := array['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'x'];
begin
  if strpos(p_title, chr(8212)) > 0 then
    return 'Titles never contain an em dash; use a comma, a colon or the word and.';
  end if;
  if p_title ~ '[.!?]$' then
    return format('A %s title is not a sentence; remove the closing punctuation.', p_kind);
  end if;
  if v_grammar like 'Imperative verb first%' then
    if v_first in ('a', 'an', 'the', 'this', 'that', 'our', 'new', 'all') then
      return format('A %s title starts with an imperative verb, for example "Install the truss"; "%s" is not a verb.', p_kind, v_words[1]);
    end if;
    if v_first ~ '.{2,}ing$' then
      return format('A %s title starts with an imperative verb, not "%s": write the command form, for example "Install" rather than "Installing".', p_kind, v_words[1]);
    end if;
    if v_first ~ '.{2,}ed$' then
      return format('A %s title starts with an imperative verb, not the past tense "%s": write the command form, for example "Install" rather than "Installed".', p_kind, v_words[1]);
    end if;
  elsif v_grammar like 'Noun phrase%' then
    if lower(' ' || p_title || ' ') ~ ' (is|are|was|were|will|would|may|might|could|has been|have been) ' then
      return format('A %s title is a noun phrase naming the thing, not a sentence describing it; for example "Rigging Plan" rather than "The rigging plan is late".', p_kind);
    end if;
  elsif v_grammar like 'Proper title%' then
    foreach v_word in array v_words loop
      if v_word ~ '^[a-z]' and not (lower(v_word) = any (v_small)) then
        return format('A %s title is a proper title in Title Case; capitalize "%s".', p_kind, v_word);
      end if;
    end loop;
  elsif v_grammar like 'Achieved-state%' or v_grammar like 'Completed-state%' then
    if not exists (
      select 1 from unnest(v_words) w
      where lower(regexp_replace(w, '[^A-Za-z]', '', 'g')) ~ '(ed|en)$'
         or lower(regexp_replace(w, '[^A-Za-z]', '', 'g')) in ('complete', 'done', 'live', 'open', 'final', 'achieved', 'reached', 'secured', 'won')
    ) then
      return format('A %s title states the result as already true, for example "Permits Approved" or "Stage Load-In Complete".', p_kind);
    end if;
  elsif v_grammar like 'role%block%' then
    if p_title !~ '^\S.* · \S.*$' then
      return format('A %s title is written role · block, for example "Stagehand · Load-in".', p_kind);
    end if;
  end if;
  return null;
end;
$$;

comment on function private.title_grammar_refusal(text, text) is 'Checks a record title against its kind''s canon title grammar (Bible tab 24) and returns the correction message, or NULL when the title is well formed.';
revoke all on function private.title_grammar_refusal(text, text) from public, anon, authenticated;

create or replace function private.guard_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text;
  v_category_xyz text;
  v_scope_project uuid;
begin
  if tg_op = 'UPDATE' then
    if new.record_kind <> old.record_kind then
      perform private.refuse('record_kind_immutable', 'A record keeps its kind; create a record of the other kind instead.');
    end if;
    if new.project_id <> old.project_id then
      perform private.refuse('record_project_immutable', 'A record stays in its project.');
    end if;
    if new.record_number <> old.record_number then
      perform private.refuse('record_number_immutable', 'A record keeps its display key.');
    end if;
    if new.deleted_at is not null and old.deleted_at is null and old.record_state = 'Canceled' then
      perform private.refuse('record_retained', 'Canceled records are retained, never deleted.');
    end if;
  else
    new.record_number := private.next_sequence(new.org_id, 'project:' || new.project_id::text);
  end if;

  if tg_op = 'INSERT' or new.title <> old.title then
    v_refusal := private.title_grammar_refusal(new.record_kind, new.title);
    if v_refusal is not null then
      perform private.refuse('record_title_grammar', v_refusal);
    end if;
  end if;

  if new.scope_node_id is not null then
    select n.project_id into v_scope_project from app.scope_nodes n where n.id = new.scope_node_id;
    if v_scope_project <> new.project_id then
      perform private.refuse('record_scope_project', 'A record''s scope node belongs to the record''s project.');
    end if;
  end if;

  if new.xyz_basis = 'Category' then
    select c.xyz into v_category_xyz from xpms.dim_category c where c.cat_urid = new.urid;
    if v_category_xyz is null or v_category_xyz <> new.xyz then
      perform private.refuse('record_xyz_basis',
        format('An XYZ tag with basis Category equals the category''s tag (%s); declare it instead to differ.', coalesce(v_category_xyz, 'none')));
    end if;
  end if;

  perform private.assert_time_zone(new.time_zone);
  return new;
end;
$$;

comment on function private.guard_record() is 'Records: display number issued on insert, kind, project and number immutable, title grammar validated with a correction message, scope node in the same project, XYZ basis honored, IANA zone, Canceled records retained.';

create or replace function private.refuse_record_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.record_state = 'Canceled' then
    perform private.refuse('record_retained', 'Canceled records are retained, never deleted.');
  end if;
  return old;
end;
$$;

comment on function private.refuse_record_delete() is 'Before delete trigger: Canceled records are retained, never deleted (Section 3.10).';

create trigger t40_guard_record before insert or update on app.records
  for each row execute function private.guard_record();
create trigger t41_record_state before insert or update on app.records
  for each row execute function private.guard_lifecycle_state('record_state', 'record', 'Proposed');
create trigger t42_refuse_record_delete before delete on app.records
  for each row execute function private.refuse_record_delete();

create table app.record_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  from_state text references xpms.dim_record_state (record_state),
  to_state text not null references xpms.dim_record_state (record_state),
  reason text not null,
  constraint record_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index record_state_transitions_record_id_idx on app.record_state_transitions (record_id);
create index record_state_transitions_from_state_idx on app.record_state_transitions (from_state);
create index record_state_transitions_to_state_idx on app.record_state_transitions (to_state);

call private.install_domain_table('app.record_state_transitions', 'app.records', 'record_id', '{}', true);
call private.describe('app.record_state_transitions', 'Append-only ledger of record state changes, written only by app.transition_record and record creation.', array[
  'record_id', 'Record that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

create table app.record_replans (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  from_state text not null references xpms.dim_record_state (record_state),
  to_state text not null references xpms.dim_record_state (record_state),
  old_starts_at timestamptz,
  new_starts_at timestamptz,
  old_ends_at timestamptz,
  new_ends_at timestamptz,
  old_due_at timestamptz,
  new_due_at timestamptz,
  reason text
);

create index record_replans_record_id_idx on app.record_replans (record_id);
create index record_replans_from_state_idx on app.record_replans (from_state);
create index record_replans_to_state_idx on app.record_replans (to_state);

call private.install_domain_table('app.record_replans', 'app.records', 'record_id', '{}', true);
call private.describe('app.record_replans', 'Append-only replan log (Section 3.10): from Scheduled onward every date or state change of a record is logged here; edits while Proposed or Ready overwrite with no entry.', array[
  'record_id', 'Record that was replanned.',
  'from_state', 'Record state before the change.',
  'to_state', 'Record state after the change.',
  'old_starts_at', 'Start before the change.',
  'new_starts_at', 'Start after the change.',
  'old_ends_at', 'End before the change.',
  'new_ends_at', 'End after the change.',
  'old_due_at', 'Due time before the change.',
  'new_due_at', 'Due time after the change.',
  'reason', 'Replan reason given with the change, when one was given.'
]);

create or replace function private.log_record_replan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select s.ordinal from xpms.dim_record_state s where s.record_state = old.record_state)
     < (select s.ordinal from xpms.dim_record_state s where s.record_state = 'Scheduled') then
    return null;
  end if;
  if new.record_state is distinct from old.record_state or new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at or new.due_at is distinct from old.due_at then
    insert into app.record_replans (record_id, from_state, to_state, old_starts_at, new_starts_at,
      old_ends_at, new_ends_at, old_due_at, new_due_at, reason)
    values (new.id, old.record_state, new.record_state, old.starts_at, new.starts_at,
      old.ends_at, new.ends_at, old.due_at, new.due_at,
      case when new.replan_reason is distinct from old.replan_reason then new.replan_reason end);
  end if;
  return null;
end;
$$;

comment on function private.log_record_replan() is 'After update trigger: logs a replan when a record that was Scheduled or later changes its dates or state (Section 3.10).';

create trigger t80_log_record_state after insert on app.records
  for each row execute function private.log_initial_state('app.record_state_transitions', 'record_id', 'record_state');
create trigger t81_log_record_replan after update on app.records
  for each row execute function private.log_record_replan();
create trigger t90_emit_record_created after insert on app.records
  for each row execute function private.emit_row_event('record.created', 'project_id', 'record_kind', 'record_subtype', 'record_number', 'title', 'record_state');
create trigger t90_emit_record_state after insert on app.record_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('record.state_changed', 'records', 'record_id', 'from_state', 'to_state', 'reason');
create trigger t90_emit_record_replan after insert on app.record_replans
  for each row execute function private.emit_subject_event('record.replanned', 'records', 'record_id', 'from_state', 'to_state', 'new_starts_at', 'new_ends_at', 'new_due_at');

-- Assignments, watchers, external visibility ----------------------------------------------------------------------------

create table app.record_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  membership_id uuid not null references app.memberships (id),
  deleted_at timestamptz
);

create index record_assignments_record_id_idx on app.record_assignments (record_id);
create index record_assignments_membership_id_idx on app.record_assignments (membership_id);
create unique index record_assignments_record_membership_key on app.record_assignments (record_id, membership_id) where deleted_at is null;

call private.install_domain_table('app.record_assignments', 'app.records', 'record_id', array['app.memberships', 'membership_id']);
call private.describe('app.record_assignments', 'Org members assigned to a record, for example crew on a task. Assignment makes the record readable to the person and gives assigned-reach capabilities on it (invariant 2, Section 8 project roles).', array[
  'record_id', 'Record.',
  'membership_id', 'Membership of the assigned person, in the record''s org.'
]);

create table app.record_watchers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  person_id uuid not null references app.people (id),
  deleted_at timestamptz
);

create index record_watchers_record_id_idx on app.record_watchers (record_id);
create index record_watchers_person_id_idx on app.record_watchers (person_id);
create unique index record_watchers_record_person_key on app.record_watchers (record_id, person_id) where deleted_at is null;

call private.install_domain_table('app.record_watchers', 'app.records', 'record_id');
call private.describe('app.record_watchers', 'People following a record to be notified of its changes (Section 4.10). Watching never grants read access.', array[
  'record_id', 'Watched record.',
  'person_id', 'Watching person.'
]);

create table app.record_external_visibility (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  external_role_type app.external_role_type,
  person_id uuid references app.people (id),
  organization_id uuid references app.organizations (id),
  deleted_at timestamptz,
  constraint record_external_visibility_one_audience check (num_nonnulls(external_role_type, person_id, organization_id) = 1)
);

create index record_external_visibility_record_id_idx on app.record_external_visibility (record_id);
create index record_external_visibility_person_id_idx on app.record_external_visibility (person_id);
create index record_external_visibility_organization_id_idx on app.record_external_visibility (organization_id);
create unique index record_external_visibility_role_key on app.record_external_visibility (record_id, external_role_type)
  where external_role_type is not null and deleted_at is null;

call private.install_domain_table('app.record_external_visibility', 'app.records', 'record_id');
call private.describe('app.record_external_visibility', 'Which external role types or named parties may see a record (Section 7.4 external_visibility), one row each. No rows means the record is internal only. External reach itself is granted through engagements (Section 8.7).', array[
  'record_id', 'Record shown externally.',
  'external_role_type', 'External role type that may see the record, for example Client.',
  'person_id', 'Named external person who may see the record.',
  'organization_id', 'Named external organization whose engaged people may see the record.'
]);

-- Checklist items -----------------------------------------------------------------------------------------------------------

create table app.record_checklist_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  position integer not null,
  label text not null,
  checked_at timestamptz,
  checked_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint record_checklist_items_position_positive check (position > 0),
  constraint record_checklist_items_label_length check (char_length(btrim(label)) between 1 and 300),
  constraint record_checklist_items_checked_pair check ((checked_at is null) = (checked_by is null))
);

create index record_checklist_items_record_id_idx on app.record_checklist_items (record_id);
create index record_checklist_items_checked_by_idx on app.record_checklist_items (checked_by);
create unique index record_checklist_items_record_position_key on app.record_checklist_items (record_id, position) where deleted_at is null;

call private.install_domain_table('app.record_checklist_items', 'app.records', 'record_id');
call private.describe('app.record_checklist_items', 'Checklist items of a record, one row per item (Section 7.4), so a tick always lands on the item it names.', array[
  'record_id', 'Record the item belongs to. Never changes.',
  'position', 'Order of the item within the record.',
  'label', 'What must be done.',
  'checked_at', 'When the item was ticked; NULL while open.',
  'checked_by', 'Person who ticked the item, set from the session.'
]);

create or replace function private.guard_checklist_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.record_id <> old.record_id then
    perform private.refuse('checklist_item_record_immutable', 'A checklist item stays on its record.');
  end if;
  if new.checked_at is null then
    new.checked_by := null;
  elsif tg_op = 'INSERT' or old.checked_at is null then
    new.checked_at := now();
    new.checked_by := private.current_person_id();
  else
    new.checked_at := old.checked_at;
    new.checked_by := old.checked_by;
  end if;
  return new;
end;
$$;

comment on function private.guard_checklist_item() is 'Checklist items stay on their record; a tick is stamped with the database time and the session person.';

create trigger t40_guard_checklist_item before insert or update on app.record_checklist_items
  for each row execute function private.guard_checklist_item();

-- Dependencies ----------------------------------------------------------------------------------------------------------------

create table app.record_dependencies (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  predecessor_record_id uuid not null references app.records (id),
  successor_record_id uuid not null references app.records (id),
  dependency_type app.dependency_type not null default 'Finish to Start',
  lag interval not null default '0',
  deleted_at timestamptz,
  constraint record_dependencies_distinct check (predecessor_record_id <> successor_record_id)
);

create index record_dependencies_predecessor_idx on app.record_dependencies (predecessor_record_id);
create index record_dependencies_successor_idx on app.record_dependencies (successor_record_id);
create unique index record_dependencies_pair_key on app.record_dependencies (predecessor_record_id, successor_record_id) where deleted_at is null;

call private.install_domain_table('app.record_dependencies', 'app.records', 'successor_record_id', array['app.records', 'predecessor_record_id']);
call private.describe('app.record_dependencies', 'Schedule dependencies between records of one project. The dependency graph stays acyclic.', array[
  'predecessor_record_id', 'Record that must start or finish first.',
  'successor_record_id', 'Record that depends on the predecessor.',
  'dependency_type', 'Finish to Start, Start to Start, Finish to Finish or Start to Finish.',
  'lag', 'Delay after the predecessor event; negative for lead.'
]);

create or replace function private.guard_record_dependency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select r.project_id from app.records r where r.id = new.predecessor_record_id)
     <> (select r.project_id from app.records r where r.id = new.successor_record_id) then
    perform private.refuse('dependency_project', 'Dependencies link records of the same project.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('record_dependencies:' || new.org_id::text, 0));
  if exists (
    with recursive downstream (record_id) as (
      select d.successor_record_id from app.record_dependencies d
      where d.predecessor_record_id = new.successor_record_id and d.deleted_at is null and d.id <> new.id
      union
      select d.successor_record_id from app.record_dependencies d
      join downstream s on d.predecessor_record_id = s.record_id
      where d.deleted_at is null and d.id <> new.id
    )
    select 1 from downstream where record_id = new.predecessor_record_id
  ) then
    perform private.refuse('dependency_cycle', 'This dependency would make the schedule circular.');
  end if;
  return new;
end;
$$;

comment on function private.guard_record_dependency() is 'Dependencies: both records in one project, and no cycles (checked under a per-org lock so concurrent inserts cannot close a loop).';

create trigger t40_guard_record_dependency before insert or update on app.record_dependencies
  for each row when (new.deleted_at is null)
  execute function private.guard_record_dependency();

-- Recurrences -----------------------------------------------------------------------------------------------------------------

create table app.record_recurrences (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  rrule text not null,
  time_zone text not null,
  until_at timestamptz,
  deleted_at timestamptz,
  constraint record_recurrences_rrule_format check (rrule ~ '^FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$')
);

create unique index record_recurrences_record_key on app.record_recurrences (record_id) where deleted_at is null;

call private.install_domain_table('app.record_recurrences', 'app.records', 'record_id');
call private.describe('app.record_recurrences', 'Recurrence rule of a record that repeats (Section 4.2 Work), one active rule per record.', array[
  'record_id', 'Record that recurs, the template for each occurrence.',
  'rrule', 'RFC 5545 recurrence rule, for example FREQ=WEEKLY;BYDAY=MO.',
  'time_zone', 'IANA zone the rule is evaluated in.',
  'until_at', 'Last instant an occurrence may start; NULL for no end.'
]);

create or replace function private.guard_record_recurrence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  return new;
end;
$$;

comment on function private.guard_record_recurrence() is 'Recurrence rules are evaluated in a known IANA zone.';

create trigger t40_guard_record_recurrence before insert or update on app.record_recurrences
  for each row execute function private.guard_record_recurrence();

-- Gate evidence may reference a record ------------------------------------------------------------------------------------------

alter table app.gate_evidence add column record_id uuid references app.records (id);
create index gate_evidence_record_id_idx on app.gate_evidence (record_id);
comment on column app.gate_evidence.record_id is 'Record that evidences the criterion, for example a Permit or Inspection record.';

drop trigger if exists t30_refuse_cross_org_reference on app.gate_evidence;
create trigger t30_refuse_cross_org_reference before insert or update on app.gate_evidence
  for each row execute function private.refuse_cross_org_reference('app.records', 'record_id');

create or replace function private.guard_gate_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.attested_by := private.current_person_id();
    new.attested_at := now();
    if new.evidence_uri is null and new.record_id is null then
      perform private.refuse('gate_evidence_reference', 'Evidence names a document or a record.');
    end if;
    if new.record_id is not null
       and (select r.project_id from app.records r where r.id = new.record_id) <> new.project_id then
      perform private.refuse('gate_evidence_record_project', 'Evidence records belong to the project the evidence is for.');
    end if;
    return new;
  end if;
  if new.project_id <> old.project_id or new.criterion_id <> old.criterion_id
     or new.evidence_uri is distinct from old.evidence_uri or new.record_id is distinct from old.record_id
     or new.note is distinct from old.note
     or new.assertion_rank <> old.assertion_rank or new.attested_by is distinct from old.attested_by
     or new.attested_at <> old.attested_at then
    perform private.refuse('gate_evidence_immutable', 'Evidence is withdrawn, never edited; attest new evidence instead.');
  end if;
  return new;
end;
$$;

-- Scope helpers: records -------------------------------------------------------------------------------------------------------

create or replace function private.my_record_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.records r
  where r.deleted_at is null
    and r.org_id in (select private.my_org_ids())
    and private.capability_reach(r.org_id, p_capability) is not null
    and (
      r.owner_party_id = private.current_person_id()
      or r.accountable_party_id = private.current_person_id()
      or exists (
        select 1 from app.record_assignments a
        where a.record_id = r.id and a.deleted_at is null
          and a.membership_id in (select private.my_membership_ids()))
    )
  union
  select rg.target_id from app.record_grants rg
  where rg.target_kind = 'record' and rg.capability_code = p_capability
    and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
    and (rg.grantee_person_id = private.current_person_id() or rg.grantee_org_id in (select private.my_org_ids()));
$$;

comment on function private.my_record_ids(text) is 'Invariant 2: records the signed-in person may use a capability on because they are assigned to them (owner, accountable party or assignee) and hold the capability at any reach, or through a record grant.';

create or replace function private.record_ids_with(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.records r
  where r.deleted_at is null and r.project_id in (select private.project_ids_with(p_capability))
  union
  select private.my_record_ids(p_capability);
$$;

comment on function private.record_ids_with(text) is 'Records the signed-in person may use a capability on: every record of a project they may use it on, plus records assigned to them. Child tables of records use it in their policies.';

create or replace function private.readable_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.project_ids_with('projects.project.read')
  union
  select r.project_id from app.records r where r.id in (select private.my_record_ids('work.record.read'));
$$;

comment on function private.readable_project_ids() is 'Projects whose header the signed-in person may read: projects they may read under invariant 2, and projects of records assigned to them.';

create or replace function private.scope_org(p_kind app.grant_target_kind, p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  case p_kind
    when 'organization' then
      return (select o.id from app.organizations o where o.id = p_id);
    when 'workspace' then
      return (select w.org_id from app.workspaces w where w.id = p_id);
    when 'team' then
      return (select t.org_id from app.teams t where t.id = p_id);
    when 'project' then
      return (select p.org_id from app.projects p where p.id = p_id);
    when 'record' then
      return (select r.org_id from app.records r where r.id = p_id);
    else
      return null;
  end case;
end;
$$;

comment on function private.scope_org(app.grant_target_kind, uuid) is 'Owning org of a grant target, or null when the target is unknown. Resolves organizations, workspaces, teams, projects and records (ADR 0008).';

create or replace function private.is_assigned_to_scope(p_org_id uuid, p_scope_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.workspace_members wm
    where wm.workspace_id = p_scope_id and wm.org_id = p_org_id and wm.deleted_at is null
      and wm.membership_id in (select private.my_membership_ids())
  ) or exists (
    select 1 from app.team_members tm
    where tm.team_id = p_scope_id and tm.org_id = p_org_id and tm.deleted_at is null
      and tm.membership_id in (select private.my_membership_ids())
  ) or exists (
    select 1 from app.projects p
    where p.id = p_scope_id and p.org_id = p_org_id and p.deleted_at is null
      and p.id in (select private.my_project_ids())
  ) or exists (
    select 1 from app.scope_nodes n
    where n.id = p_scope_id and n.org_id = p_org_id and n.deleted_at is null
      and n.project_id in (select private.my_project_ids())
  ) or exists (
    select 1 from app.records r
    where r.id = p_scope_id and r.org_id = p_org_id and r.deleted_at is null
      and (r.project_id in (select private.my_project_ids())
           or r.owner_party_id = private.current_person_id()
           or r.accountable_party_id = private.current_person_id()
           or exists (select 1 from app.record_assignments a
                      where a.record_id = r.id and a.deleted_at is null
                        and a.membership_id in (select private.my_membership_ids())))
  );
$$;

comment on function private.is_assigned_to_scope(uuid, uuid) is 'True when the signed-in person is assigned to the scope: a workspace or team they belong to, a project they are an active member of or one of its scope nodes, or a record of such a project or assigned to them (ADR 0008).';

-- Computed fields -----------------------------------------------------------------------------------------------------------

create or replace function app.record_display_key(p_record app.records)
returns text
language sql
stable
set search_path = ''
as $$
  select p.project_key || '-' || p_record.record_number::text from app.projects p where p.id = p_record.project_id;
$$;

comment on function app.record_display_key(app.records) is 'Computed field: the record''s display key {project_key}-{record_number} (Section 4.5.1). Follows the project key when it changes. Runs with the caller''s rights.';

create or replace function app.record_class(p_record app.records)
returns text
language sql
stable
set search_path = ''
as $$
  select k.record_class from xpms.dim_record_kind k where k.record_kind = p_record.record_kind;
$$;

comment on function app.record_class(app.records) is 'Computed field: the record''s class, a fact of its kind (Bible tab 24), never stored on the record.';

-- Record state RPC -------------------------------------------------------------------------------------------------------------

create or replace function app.transition_record(
  p_record_id uuid,
  p_expected text,
  p_next text,
  p_reason text,
  p_blocker_text text default null,
  p_replan_reason text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
begin
  perform private.require_person();
  if not exists (select 1 from private.record_ids_with('work.record.write') x where x = p_record_id) then
    raise exception using errcode = '42501', message = 'work.record.write is required on the record';
  end if;
  if p_next = 'Blocked' and (p_blocker_text is null or char_length(btrim(p_blocker_text)) = 0) then
    perform private.refuse('record_blocker_required', 'A Blocked record names its blocker.');
  end if;
  if p_next = 'Deferred' and (p_replan_reason is null or char_length(btrim(p_replan_reason)) = 0) then
    perform private.refuse('record_replan_reason_required', 'A Deferred record carries a replan reason.');
  end if;
  update app.records
  set blocker_text = case when p_next = 'Blocked' then btrim(p_blocker_text) else blocker_text end,
      replan_reason = case when p_replan_reason is not null then btrim(p_replan_reason) else replan_reason end
  where id = p_record_id;
  v_entry := private.transition_lifecycle('record', 'app.records', 'record_state', 'app.record_state_transitions',
    'record_id', p_record_id, p_expected, p_next, p_reason);
  if p_expected = 'Blocked' then
    update app.records set blocker_text = null where id = p_record_id;
  end if;
  return v_entry;
end;
$$;

comment on function app.transition_record(uuid, text, text, text, text, text) is 'Moves a record to another record state with compare-and-set on the expected state. Blocked needs a blocker and Deferred a replan reason; leaving Blocked clears the blocker. Needs work.record.write on the record. Returns the ledger entry id.';

-- Policies ---------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.records',
  $$project_id in (select private.project_ids_with('work.record.read'))
    or id in (select private.my_record_ids('work.record.read'))
    or org_id in (select private.oversight_org_ids('work.record.read'))$$,
  $$project_id in (select private.project_ids_with('work.record.write'))$$,
  $$project_id in (select private.project_ids_with('work.record.write'))
    or id in (select private.my_record_ids('work.record.write'))$$);

call private.install_policies('app.record_state_transitions',
  $$record_id in (select private.record_ids_with('work.record.read'))$$);
call private.install_policies('app.record_replans',
  $$record_id in (select private.record_ids_with('work.record.read'))$$);

call private.install_policies('app.record_assignments',
  $$record_id in (select private.record_ids_with('work.record.read'))$$,
  $$record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('work.record.write')))$$);

call private.install_policies('app.record_watchers',
  $$record_id in (select private.record_ids_with('work.record.read'))$$,
  $$record_id in (select private.record_ids_with('work.record.read'))
    and (person_id = (select private.current_person_id())
         or record_id in (select private.record_ids_with('work.record.write')))$$);

call private.install_policies('app.record_external_visibility',
  $$record_id in (select private.record_ids_with('work.record.read'))$$,
  $$record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('work.record.write')))$$);

call private.install_policies('app.record_checklist_items',
  $$record_id in (select private.record_ids_with('work.record.read'))$$,
  $$record_id in (select private.record_ids_with('work.record.write'))$$);

call private.install_policies('app.record_dependencies',
  $$successor_record_id in (select private.record_ids_with('work.record.read'))$$,
  $$successor_record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('schedule.timeline.write')))$$);

call private.install_policies('app.record_recurrences',
  $$record_id in (select private.record_ids_with('work.record.read'))$$,
  $$record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('work.recurring.write')))$$);

-- Function privileges ---------------------------------------------------------------------------------------------------------

revoke all on function private.guard_record() from public, anon, authenticated;
revoke all on function private.refuse_record_delete() from public, anon, authenticated;
revoke all on function private.log_record_replan() from public, anon, authenticated;
revoke all on function private.guard_checklist_item() from public, anon, authenticated;
revoke all on function private.guard_record_dependency() from public, anon, authenticated;
revoke all on function private.guard_record_recurrence() from public, anon, authenticated;
revoke all on function private.my_record_ids(text) from public, anon;
revoke all on function private.record_ids_with(text) from public, anon;
revoke all on function app.record_display_key(app.records) from public, anon;
revoke all on function app.record_class(app.records) from public, anon;
revoke all on function app.transition_record(uuid, text, text, text, text, text) from public, anon;

grant execute on function private.my_record_ids(text) to authenticated, service_role;
grant execute on function private.record_ids_with(text) to authenticated, service_role;
grant execute on function app.record_display_key(app.records) to authenticated, service_role;
grant execute on function app.record_class(app.records) to authenticated, service_role;
grant execute on function app.transition_record(uuid, text, text, text, text, text) to authenticated, service_role;
