-- 0301_scope.sql
-- A03 Domain Data. Scope (Section 7.4 Scope, Section 4.5.1, Section 3.4): venues, counterparties,
-- projects with their project and production lifecycles, project members and project roles, the
-- ltree scope tree, gate evidence on one evidence spine, the phase transition ledger, the gate
-- transition RPC (invariant 9), the domain event table webhooks read (Section 10.1), and the
-- extension of A02's scope helpers to projects (ADR 0008).
--
-- Invariant 2 (Section 7.5): project data is readable by project members and by people assigned to
-- it, not by the whole org. private.project_ids_with(capability) is the one place that rule lives:
-- a project counts when the person holds the capability and is an active project member, or holds
-- it org-wide together with projects.members.manage org-wide (project oversight: whoever can add
-- themselves to any project reads every project), or holds a grant scoped to the project.

-- Enums ----------------------------------------------------------------------------------------------

create type app.project_state as enum ('Proposed', 'Active', 'Blocked', 'Complete', 'Canceled');
comment on type app.project_state is 'Project lifecycle (Section 3.12, lifecycle 1) in the shared state vocabulary (Bible tab 37 core states). Changed only by app.transition_project.';

create type app.production_state as enum ('Proposed', 'Active', 'Blocked', 'Complete', 'Closed', 'Canceled');
comment on type app.production_state is 'Production lifecycle (Section 3.12, lifecycle 2): the operational and financial run of a project. Closed is a declared extension of the shared vocabulary meaning financially closed; a Closed production refuses new spend (invariant 10).';

create type app.project_role as enum ('Producer', 'Department Head', 'Coordinator', 'Field Supervisor', 'Field');
comment on type app.project_role is 'Project roles (Section 8), which narrow scope inside a project.';

create type app.scope_kind as enum ('Engagement Root', 'Standing Venue', 'Show');
comment on type app.scope_kind is 'Kinds of scope tree node (Section 4.5.1): the engagement root, a standing venue, a show.';

-- Lifecycle rules -------------------------------------------------------------------------------------

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('project', 'Proposed', 'Active'),
  ('project', 'Proposed', 'Canceled'),
  ('project', 'Active', 'Blocked'),
  ('project', 'Active', 'Complete'),
  ('project', 'Active', 'Canceled'),
  ('project', 'Blocked', 'Active'),
  ('project', 'Blocked', 'Canceled'),
  ('project', 'Complete', 'Active'),
  ('production', 'Proposed', 'Active'),
  ('production', 'Proposed', 'Canceled'),
  ('production', 'Active', 'Blocked'),
  ('production', 'Active', 'Complete'),
  ('production', 'Active', 'Canceled'),
  ('production', 'Blocked', 'Active'),
  ('production', 'Blocked', 'Canceled'),
  ('production', 'Complete', 'Active'),
  ('production', 'Complete', 'Closed');

-- Domain event catalog -----------------------------------------------------------------------------------

create table private.domain_event_types (
  code text primary key,
  subject text not null,
  description text not null,
  constraint domain_event_types_code_format check (code ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  constraint domain_event_types_description_length check (char_length(btrim(description)) between 1 and 300)
);

comment on table private.domain_event_types is 'The webhook event catalog (Section 10.1): every event the domain emits, generated into the API reference from this table.';
comment on column private.domain_event_types.code is 'Event code, subject first, for example record.created.';
comment on column private.domain_event_types.subject is 'Table whose rows the event describes.';
comment on column private.domain_event_types.description is 'Sentence-case description of when the event fires.';

alter table private.domain_event_types enable row level security;
revoke all on private.domain_event_types from public, anon, authenticated;
grant select on private.domain_event_types to service_role;

insert into private.domain_event_types (code, subject, description) values
  ('project.created', 'projects', 'A project was created.'),
  ('project.state_changed', 'projects', 'A project moved to another project state.'),
  ('project.production_state_changed', 'projects', 'A project''s production moved to another production state.'),
  ('project.gate_passed', 'projects', 'A project passed a gate and entered the next phase.'),
  ('project.member_added', 'project_members', 'A member was added to a project.'),
  ('gate.evidence_attested', 'gate_evidence', 'Evidence was attested against a gate criterion.');

create view app.domain_event_catalog as
select t.code, t.subject, t.description from private.domain_event_types t;

comment on view app.domain_event_catalog is 'The webhook event catalog: event codes, subjects and descriptions.';
comment on column app.domain_event_catalog.code is 'Event code.';
comment on column app.domain_event_catalog.subject is 'Table whose rows the event describes.';
comment on column app.domain_event_catalog.description is 'When the event fires.';

revoke all on app.domain_event_catalog from public, anon;
grant select on app.domain_event_catalog to authenticated, service_role;

-- Venues ----------------------------------------------------------------------------------------------------

create table app.venues (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  jurisdiction_id text not null references xpms.jurisdiction (jurisdiction_id),
  time_zone text not null,
  street_address text,
  locality text,
  postal_code text,
  deleted_at timestamptz,
  constraint venues_name_length check (char_length(btrim(name)) between 1 and 200)
);

create index venues_jurisdiction_id_idx on app.venues (jurisdiction_id);
create unique index venues_org_name_key on app.venues (org_id, lower(name)) where deleted_at is null;

call private.install_domain_table('app.venues');
call private.describe('app.venues', 'Venues the org produces in (Section 7.4 Places, engagement contract). The venue''s jurisdiction supplies permit rules and responding agencies.', array[
  'name', 'Venue name, unique within the org ignoring case.',
  'jurisdiction_id', 'Jurisdiction the venue sits in, at the finest level known (country, region or AHJ).',
  'time_zone', 'IANA time zone of the venue; local times typed for the venue are read in it.',
  'street_address', 'Street address line.',
  'locality', 'City or locality.',
  'postal_code', 'Postal code.'
]);

-- Counterparties -----------------------------------------------------------------------------------------------
-- The org-side relationship row for another organization (Section 3.15 rule 4): which company, as
-- what counterparty type. The company's name lives once, on app.organizations.

create table app.counterparties (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  organization_id uuid not null references app.organizations (id),
  counterparty_type text references xpms.dim_counterparty_type (counterparty_type),
  deleted_at timestamptz,
  constraint counterparties_not_self check (organization_id <> org_id)
);

create index counterparties_organization_id_idx on app.counterparties (organization_id);
create index counterparties_counterparty_type_idx on app.counterparties (counterparty_type);
create unique index counterparties_org_organization_key on app.counterparties (org_id, organization_id) where deleted_at is null;

call private.install_domain_table('app.counterparties');
call private.describe('app.counterparties', 'Another organization as this org deals with it: client, vendor, sponsor or other counterparty (Bible tab 28). Holds only org-owned facts; the company''s identity and name live on app.organizations.', array[
  'organization_id', 'The other organization. Never the owning org itself.',
  'counterparty_type', 'Vendor counterparty type from canon (Bible tab 28); NULL for a client or another relationship canon does not type.'
]);

create or replace function app.counterparty_name(p_counterparty app.counterparties)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name from app.organizations o
  join app.counterparties c on c.organization_id = o.id
  where c.id = p_counterparty.id and c.organization_id = p_counterparty.organization_id
    and c.org_id in (select private.my_org_ids());
$$;

comment on function app.counterparty_name(app.counterparties) is 'Computed field: the counterparty organization''s name, read from its one home on app.organizations, for members of the org that holds the relationship.';

-- Projects ------------------------------------------------------------------------------------------------------

create table app.projects (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  workspace_id uuid references app.workspaces (id),
  venue_id uuid references app.venues (id),
  client_counterparty_id uuid references app.counterparties (id),
  project_key text not null,
  name text not null,
  jurisdiction_id text references xpms.jurisdiction (jurisdiction_id),
  region_code text references xpms.dim_region (region_code),
  tier_code text references xpms.dim_tier (tier_code),
  current_phase_code text not null default 'SCP' references xpms.dim_phase (phase_code),
  project_state app.project_state not null default 'Proposed',
  production_state app.production_state not null default 'Proposed',
  time_zone text not null,
  starts_on date,
  ends_on date,
  archived_at timestamptz,
  deleted_at timestamptz,
  constraint projects_key_format check (project_key ~ '^[A-Z]{2,5}$'),
  constraint projects_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint projects_dates check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create unique index projects_org_key_key on app.projects (org_id, project_key) where deleted_at is null;
create index projects_workspace_id_idx on app.projects (workspace_id);
create index projects_venue_id_idx on app.projects (venue_id);
create index projects_client_counterparty_id_idx on app.projects (client_counterparty_id);
create index projects_jurisdiction_id_idx on app.projects (jurisdiction_id);
create index projects_region_code_idx on app.projects (region_code);
create index projects_tier_code_idx on app.projects (tier_code);
create index projects_current_phase_code_idx on app.projects (current_phase_code);

call private.install_domain_table('app.projects', null, null,
  array['app.workspaces', 'workspace_id', 'app.venues', 'venue_id', 'app.counterparties', 'client_counterparty_id']);
call private.describe('app.projects', 'One engagement with jurisdiction, phase and gates (Section 4.5.1, Section 7.4 Scope). Project data is readable by project members and assigned people, not the whole org (invariant 2).', array[
  'workspace_id', 'Workspace that scopes the project, when the org uses workspaces.',
  'venue_id', 'Primary venue; its jurisdiction supplies responding agencies (engagement contract project_authority).',
  'client_counterparty_id', 'Client the project is produced for.',
  'project_key', 'Two to five capital letters, unique per org (for example NWL). Record display keys are {project_key}-{sequence}.',
  'name', 'Project name.',
  'jurisdiction_id', 'Jurisdiction resolved for the project at gate 1 (Section 3.5). NULL until resolved; an unresolved jurisdiction answers no permit or code question.',
  'region_code', 'Cost region the project prices in (Bible tab 12).',
  'tier_code', 'Tier of experience (Bible tab 07).',
  'current_phase_code', 'Current gated phase. Changes only through app.pass_gate (invariant 9).',
  'project_state', 'Project lifecycle state. Changes only through app.transition_project.',
  'production_state', 'Production lifecycle state. Changes only through app.transition_production; Closed refuses new spend (invariant 10).',
  'time_zone', 'IANA time zone the project''s typed local times are entered in.',
  'starts_on', 'First production day.',
  'ends_on', 'Last production day.',
  'archived_at', 'When the project was archived. Archived projects stay searchable behind a filter (Section 4.10).'
]);

create table app.project_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  from_state app.project_state,
  to_state app.project_state not null,
  reason text not null,
  constraint project_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index project_state_transitions_project_id_idx on app.project_state_transitions (project_id);

call private.install_domain_table('app.project_state_transitions', 'app.projects', 'project_id', '{}', true);
call private.describe('app.project_state_transitions', 'Append-only ledger of project state changes, written only by app.transition_project and project creation.', array[
  'project_id', 'Project that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

create table app.production_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  from_state app.production_state,
  to_state app.production_state not null,
  reason text not null,
  constraint production_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index production_state_transitions_project_id_idx on app.production_state_transitions (project_id);

call private.install_domain_table('app.production_state_transitions', 'app.projects', 'project_id', '{}', true);
call private.describe('app.production_state_transitions', 'Append-only ledger of production state changes, written only by app.transition_production and project creation.', array[
  'project_id', 'Project whose production changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

create table app.project_phase_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  gate integer not null references xpms.dim_phase (gate),
  from_phase_code text not null references xpms.dim_phase (phase_code),
  to_phase_code text references xpms.dim_phase (phase_code),
  reason text not null,
  constraint project_phase_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index project_phase_transitions_project_id_idx on app.project_phase_transitions (project_id);
create index project_phase_transitions_gate_idx on app.project_phase_transitions (gate);
create index project_phase_transitions_from_phase_code_idx on app.project_phase_transitions (from_phase_code);
create index project_phase_transitions_to_phase_code_idx on app.project_phase_transitions (to_phase_code);
create unique index project_phase_transitions_once_per_gate on app.project_phase_transitions (project_id, gate);

call private.install_domain_table('app.project_phase_transitions', 'app.projects', 'project_id', '{}', true);
call private.describe('app.project_phase_transitions', 'Append-only ledger of gates passed, written only by app.pass_gate (invariant 9). Each gate is passed at most once.', array[
  'project_id', 'Project that passed the gate.',
  'gate', 'Gate passed, 1 to 9.',
  'from_phase_code', 'Phase the project left.',
  'to_phase_code', 'Phase the project entered; NULL when gate 9 closes the last phase.',
  'reason', 'Why the gate was passed, for example the go or no-go decision.'
]);

-- Project members --------------------------------------------------------------------------------------------------

create table app.project_members (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  membership_id uuid not null references app.memberships (id),
  project_role app.project_role not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  deleted_at timestamptz,
  constraint project_members_valid_period check (valid_to is null or valid_to >= valid_from)
);

create index project_members_project_id_idx on app.project_members (project_id);
create index project_members_membership_id_idx on app.project_members (membership_id, project_id);
create unique index project_members_project_membership_key on app.project_members (project_id, membership_id)
  where deleted_at is null;

call private.install_domain_table('app.project_members', 'app.projects', 'project_id', array['app.memberships', 'membership_id']);
call private.describe('app.project_members', 'Org members assigned to a project with a project role (Section 8). Membership gives assigned-reach capabilities on the project and makes its data readable (invariant 2). Time-boxed.', array[
  'project_id', 'Project.',
  'membership_id', 'Org membership of the person, in the project''s org.',
  'project_role', 'Project role: Producer, Department Head, Coordinator, Field Supervisor or Field.',
  'valid_from', 'When project access starts.',
  'valid_to', 'When project access ends; NULL while open-ended.'
]);

-- Scope tree -----------------------------------------------------------------------------------------------------

create table app.scope_nodes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  parent_id uuid references app.scope_nodes (id),
  scope_kind app.scope_kind not null,
  scope_code text not null,
  name text not null,
  venue_id uuid references app.venues (id),
  path extensions.ltree not null,
  deleted_at timestamptz,
  constraint scope_nodes_code_format check (scope_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  constraint scope_nodes_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint scope_nodes_root_kind check ((parent_id is null) = (scope_kind = 'Engagement Root')),
  constraint scope_nodes_not_own_parent check (parent_id <> id)
);

create index scope_nodes_project_id_idx on app.scope_nodes (project_id);
create index scope_nodes_parent_id_idx on app.scope_nodes (parent_id);
create index scope_nodes_venue_id_idx on app.scope_nodes (venue_id);
create index scope_nodes_path_idx on app.scope_nodes using gist (path);
create unique index scope_nodes_project_code_key on app.scope_nodes (project_id, scope_code) where deleted_at is null;
create unique index scope_nodes_one_root on app.scope_nodes (project_id) where parent_id is null and deleted_at is null;

call private.install_domain_table('app.scope_nodes', 'app.projects', 'project_id',
  array['app.scope_nodes', 'parent_id', 'app.venues', 'venue_id']);
call private.describe('app.scope_nodes', 'The scope tree of a project (Section 4.5.1): one engagement root, with standing venues and shows beneath it. Every project tab filters by scope node.', array[
  'project_id', 'Project the node belongs to.',
  'parent_id', 'Parent node in the same project; NULL only for the engagement root.',
  'scope_kind', 'Engagement Root, Standing Venue or Show.',
  'scope_code', 'Scope code, unique within the project, for example NWL-E01. Event cost centers name it.',
  'name', 'Node name.',
  'venue_id', 'Venue of a standing venue or show node.',
  'path', 'Materialized ltree path of scope codes from the root (hyphens written as underscores, as ltree labels require), maintained by the database from parent_id and scope_code.'
]);

create or replace function private.guard_scope_node()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent app.scope_nodes;
begin
  if tg_op = 'UPDATE' and (new.parent_id is distinct from old.parent_id or new.scope_code <> old.scope_code
      or new.project_id <> old.project_id or new.scope_kind <> old.scope_kind) then
    perform private.refuse('scope_node_immutable', 'A scope node keeps its parent, code and kind; create another node instead.');
  end if;
  if new.parent_id is null then
    new.path := extensions.text2ltree(replace(new.scope_code, '-', '_'));
    return new;
  end if;
  select * into v_parent from app.scope_nodes n where n.id = new.parent_id;
  if v_parent.project_id <> new.project_id then
    perform private.refuse('scope_node_parent_project', 'A scope node''s parent belongs to the same project.');
  end if;
  if v_parent.deleted_at is not null then
    perform private.refuse('scope_node_parent_deleted', 'A scope node cannot be added under a deleted node.');
  end if;
  new.path := v_parent.path operator(extensions.||) extensions.text2ltree(replace(new.scope_code, '-', '_'));
  return new;
end;
$$;

comment on function private.guard_scope_node() is 'Scope nodes: parent in the same project and not deleted, parent, code and kind immutable, path maintained from the parent path and scope code.';

create trigger t40_guard_scope_node before insert or update on app.scope_nodes
  for each row execute function private.guard_scope_node();

-- Gate evidence ----------------------------------------------------------------------------------------------------
-- One evidence spine (Section 3.4): a row per piece of evidence against a canon criterion, so a new
-- criterion needs no migration. Evidence of assertion rank 0 is an absent claim and never counts.

create table app.gate_evidence (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  criterion_id text not null references xpms.dim_gate_criterion (criterion_id),
  evidence_uri text,
  note text,
  assertion_rank integer not null references xpms.dim_assertion_rank (rank),
  attested_by uuid references app.people (id),
  attested_at timestamptz not null default now(),
  constraint gate_evidence_note_length check (note is null or char_length(btrim(note)) between 1 and 2000)
);

create index gate_evidence_project_criterion_idx on app.gate_evidence (project_id, criterion_id);
create index gate_evidence_criterion_id_idx on app.gate_evidence (criterion_id);
create index gate_evidence_assertion_rank_idx on app.gate_evidence (assertion_rank);
create index gate_evidence_attested_by_idx on app.gate_evidence (attested_by);

call private.install_domain_table('app.gate_evidence', 'app.projects', 'project_id');
call private.describe('app.gate_evidence', 'Gate evidence on one evidence spine (Section 3.4, Section 7.4): one row per piece of evidence against a gate criterion. Withdrawn evidence is soft deleted and stops counting.', array[
  'project_id', 'Project the evidence is for.',
  'criterion_id', 'Canon gate criterion the evidence satisfies (Bible tab 06).',
  'evidence_uri', 'Location of the evidence document.',
  'note', 'What the evidence shows.',
  'assertion_rank', 'Assertion rank of the evidence, 0 to 4 (Bible tab 22). Rank 0 is an absent claim and never satisfies a criterion.',
  'attested_by', 'Person who attested the evidence, set from the session.',
  'attested_at', 'When the evidence was attested, set by the database.'
]);

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
    if new.evidence_uri is null then
      perform private.refuse('gate_evidence_reference', 'Evidence names a document or a record.');
    end if;
    return new;
  end if;
  if new.project_id <> old.project_id or new.criterion_id <> old.criterion_id
     or new.evidence_uri is distinct from old.evidence_uri or new.note is distinct from old.note
     or new.assertion_rank <> old.assertion_rank or new.attested_by is distinct from old.attested_by
     or new.attested_at <> old.attested_at then
    perform private.refuse('gate_evidence_immutable', 'Evidence is withdrawn, never edited; attest new evidence instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_gate_evidence() is 'Gate evidence: attested by the session person at the database time, references a document or record, and is immutable except for withdrawal.';

create trigger t40_guard_gate_evidence before insert or update on app.gate_evidence
  for each row execute function private.guard_gate_evidence();

-- Domain events ------------------------------------------------------------------------------------------------------

create table app.domain_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  event_type text not null references private.domain_event_types (code),
  subject_table text not null,
  subject_id uuid not null,
  project_id uuid references app.projects (id),
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint domain_events_data_object check (jsonb_typeof(data) = 'object')
);

create index domain_events_event_type_idx on app.domain_events (event_type);
create index domain_events_project_id_idx on app.domain_events (project_id);
create index domain_events_org_occurred_idx on app.domain_events (org_id, occurred_at);
create index domain_events_subject_idx on app.domain_events (subject_id);

call private.install_domain_table('app.domain_events', null, null, array['app.projects', 'project_id'], true);
call private.describe('app.domain_events', 'Append-only domain event table that webhook delivery reads (Section 10.1). Rows are written only by database triggers, so every state change is emitted exactly once.', array[
  'event_type', 'Event code from the catalog, for example record.state_changed.',
  'subject_table', 'Table of the row the event describes.',
  'subject_id', 'Id of the row the event describes.',
  'project_id', 'Project of the subject, when it belongs to one, for per-project subscriptions.',
  'data', 'Outbound webhook payload: the subject fields the event names. Never carries restricted columns.',
  'occurred_at', 'When the event happened.'
]);

create or replace function private.emit_event(
  p_org_id uuid,
  p_event_type text,
  p_subject_table text,
  p_subject_id uuid,
  p_project_id uuid,
  p_data jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into app.domain_events (org_id, event_type, subject_table, subject_id, project_id, data)
  values (p_org_id, p_event_type, p_subject_table, p_subject_id, p_project_id, coalesce(p_data, '{}'::jsonb));
$$;

comment on function private.emit_event(uuid, text, text, uuid, uuid, jsonb) is 'Writes one domain event. Called only by triggers and definer RPCs.';

-- Generic row event trigger. Arguments: event type, project column (or the empty string when the row
-- is the project itself, or - for none), then the column names copied into the payload.
create or replace function private.emit_row_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_project uuid;
  v_data jsonb := '{}'::jsonb;
  i integer := 2;
begin
  if tg_argv[1] = '' then
    v_project := new.id;
  elsif tg_argv[1] <> '-' then
    v_project := (v_row ->> tg_argv[1])::uuid;
  end if;
  while i < tg_nargs loop
    v_data := v_data || jsonb_build_object(tg_argv[i], v_row -> tg_argv[i]);
    i := i + 1;
  end loop;
  perform private.emit_event(new.org_id, tg_argv[0], tg_table_name, coalesce((v_row ->> 'subject_id')::uuid, new.id), v_project, v_data);
  return null;
end;
$$;

comment on function private.emit_row_event() is 'After insert trigger: emits a domain event for the new row. Arguments: event type, project column (empty for the project itself, - for none), then the columns copied into the payload.';

-- Scope helpers (ADR 0008 consequence: A03 extends them to projects) --------------------------------------------------

create or replace function private.my_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pm.project_id from app.project_members pm
  where pm.membership_id in (select private.my_membership_ids())
    and pm.deleted_at is null
    and pm.valid_from <= now()
    and (pm.valid_to is null or pm.valid_to > now());
$$;

comment on function private.my_project_ids() is 'Projects where the signed-in person holds an active project membership through an active org membership.';

create or replace function private.project_ids_with(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select private.my_project_ids() as project_id)
  select p.id from app.projects p
  where p.deleted_at is null
    and (
      (p.org_id in (select private.orgs_with_capability(p_capability))
        and (p.org_id in (select private.orgs_with_capability('projects.members.manage'))
             or p.id in (select m.project_id from mine m)))
      or (p.id in (select m.project_id from mine m)
          and private.capability_reach(p.org_id, p_capability) = 'assigned')
      or exists (
        select 1 from app.user_capability_grants g
        where g.scope_kind = 'project' and g.scope_id = p.id and g.capability_code = p_capability
          and g.deleted_at is null and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
          and g.membership_id in (select private.my_membership_ids()))
      or exists (
        select 1 from app.record_grants rg
        where rg.target_kind = 'project' and rg.target_id = p.id and rg.capability_code = p_capability
          and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
          and (rg.grantee_person_id = private.current_person_id()
               or rg.grantee_org_id in (select private.my_org_ids())))
    );
$$;

comment on function private.project_ids_with(text) is 'Invariant 2: projects on which the signed-in person may use a capability. True for active project members holding it at assigned or organization reach, for org-wide holders who also hold projects.members.manage org-wide (oversight), and for grants scoped to the project. Policies use it as project_id in (select ...).';

create or replace function private.oversight_org_ids(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o from private.orgs_with_capability(p_capability) o
  where o in (select private.orgs_with_capability('projects.members.manage'));
$$;

comment on function private.oversight_org_ids(text) is 'Orgs where the signed-in person oversees every project for a capability: they hold it org-wide together with projects.members.manage org-wide. Lets a policy authorize a row without reading the project table, so a just-inserted project is visible to its creator.';

create or replace function private.readable_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.project_ids_with('projects.project.read');
$$;

comment on function private.readable_project_ids() is 'Projects whose header the signed-in person may read. Later migrations add people assigned to the project''s records and shifts.';

create or replace function private.can_on_project(p_project_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.project_ids_with(p_capability) x where x = p_project_id);
$$;

comment on function private.can_on_project(uuid, text) is 'True when the signed-in person may use the capability on the project (invariant 2 rule). RPCs call it before acting.';

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
    else
      return null;
  end case;
end;
$$;

comment on function private.scope_org(app.grant_target_kind, uuid) is 'Owning org of a grant target, or null when the target is unknown. Resolves organizations, workspaces, teams and projects; the record spine migration adds records.';

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
  );
$$;

comment on function private.is_assigned_to_scope(uuid, uuid) is 'True when the signed-in person is assigned to the scope: a workspace or team they belong to, a project they are an active member of, or a scope node of such a project. The record spine migration adds records.';

-- Invariant 10 ------------------------------------------------------------------------------------------------------------

create or replace function private.assert_production_open(p_project_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.projects p where p.id = p_project_id and p.production_state = 'Closed') then
    perform private.refuse('production_closed',
      'A closed production refuses new invoices, purchase orders, expenses, time entries and change orders.');
  end if;
end;
$$;

comment on function private.assert_production_open(uuid) is 'Invariant 10: refuses new spend and time against a project whose production is Closed.';

-- Project guards ----------------------------------------------------------------------------------------------------------

create or replace function private.guard_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_active bigint;
begin
  perform private.assert_time_zone(new.time_zone);
  if tg_op = 'INSERT' then
    perform 1 from app.organizations o where o.id = new.org_id for update;
    select count(*) into v_active from app.projects p
    where p.org_id = new.org_id and p.deleted_at is null and p.archived_at is null
      and p.project_state in ('Proposed', 'Active', 'Blocked');
    perform private.assert_within_plan_limit(new.org_id, 'active_projects', v_active + 1);
    return new;
  end if;
  if new.project_key <> old.project_key and not v_platform
     and not private.can_on_project(new.id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'projects.settings.write is required to change the project key';
  end if;
  if new.archived_at is distinct from old.archived_at and not v_platform
     and not private.can_on_project(new.id, 'projects.project.archive') then
    raise exception using errcode = '42501', message = 'projects.project.archive is required to archive a project';
  end if;
  return new;
end;
$$;

comment on function private.guard_project() is 'Projects: IANA time zone, the active_projects plan limit on insert (Section 16), projects.settings.write to change the key and projects.project.archive to archive.';

create trigger t40_guard_project before insert or update on app.projects
  for each row execute function private.guard_project();
create trigger t41_project_state before insert or update on app.projects
  for each row execute function private.guard_lifecycle_state('project_state', 'project', 'Proposed');
create trigger t42_production_state before insert or update on app.projects
  for each row execute function private.guard_lifecycle_state('production_state', 'production', 'Proposed');
create trigger t43_current_phase before insert or update on app.projects
  for each row execute function private.guard_lifecycle_state('current_phase_code', 'project_phase', 'SCP');
create trigger t80_log_project_state after insert on app.projects
  for each row execute function private.log_initial_state('app.project_state_transitions', 'project_id', 'project_state');
create trigger t81_log_production_state after insert on app.projects
  for each row execute function private.log_initial_state('app.production_state_transitions', 'project_id', 'production_state');
create trigger t90_emit_project_created after insert on app.projects
  for each row execute function private.emit_row_event('project.created', '', 'project_key', 'name', 'current_phase_code');

create trigger t90_emit_project_state after insert on app.project_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_row_event('project.state_changed', 'project_id', 'project_id', 'from_state', 'to_state', 'reason');
create trigger t90_emit_production_state after insert on app.production_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_row_event('project.production_state_changed', 'project_id', 'project_id', 'from_state', 'to_state', 'reason');
create trigger t90_emit_gate_passed after insert on app.project_phase_transitions
  for each row execute function private.emit_row_event('project.gate_passed', 'project_id', 'project_id', 'gate', 'from_phase_code', 'to_phase_code');
create trigger t90_emit_member_added after insert on app.project_members
  for each row execute function private.emit_row_event('project.member_added', 'project_id', 'project_id', 'membership_id', 'project_role');
create trigger t90_emit_evidence after insert on app.gate_evidence
  for each row execute function private.emit_row_event('gate.evidence_attested', 'project_id', 'project_id', 'criterion_id', 'assertion_rank');

create or replace function private.guard_project_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.membership_id <> old.membership_id) then
    perform private.refuse('project_member_immutable', 'Add the person again instead of moving a project membership.');
  end if;
  if auth.uid() is not null and tg_op = 'INSERT'
     and (select m.person_id from app.memberships m where m.id = new.membership_id) = private.current_person_id() then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  return new;
end;
$$;

comment on function private.guard_project_member() is 'Project members: a person cannot add themselves to a project (Section 8.2), and a project membership never moves to another project or person.';

create trigger t40_guard_project_member before insert or update on app.project_members
  for each row execute function private.guard_project_member();

-- Policies ----------------------------------------------------------------------------------------------------------------

call private.install_policies('app.venues',
  $$org_id in (select private.orgs_with_capability('places.venue.read'))
    or id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids()))$$,
  $$org_id in (select private.orgs_with_capability('places.venue.write'))$$);

call private.install_policies('app.counterparties',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('vendors.vendor.write'))$$);

call private.install_policies('app.projects',
  $$id in (select private.readable_project_ids())
    or org_id in (select private.oversight_org_ids('projects.project.read'))$$,
  $$org_id in (select private.orgs_with_capability('projects.project.create'))$$,
  $$id in (select private.project_ids_with('projects.project.write'))$$);

call private.install_policies('app.project_state_transitions',
  $$project_id in (select private.readable_project_ids())$$);
call private.install_policies('app.production_state_transitions',
  $$project_id in (select private.readable_project_ids())$$);
call private.install_policies('app.project_phase_transitions',
  $$project_id in (select private.project_ids_with('projects.gate.read'))$$);

call private.install_policies('app.project_members',
  $$project_id in (select private.readable_project_ids()) or membership_id in (select private.my_membership_ids())$$,
  $$project_id in (select private.project_ids_with('projects.members.manage'))$$);

call private.install_policies('app.scope_nodes',
  $$project_id in (select private.readable_project_ids())$$,
  $$project_id in (select private.project_ids_with('projects.scope.write'))$$);

call private.install_policies('app.gate_evidence',
  $$project_id in (select private.project_ids_with('projects.gate.read'))$$,
  $$project_id in (select private.project_ids_with('projects.gate.evidence.write'))$$);

call private.install_policies('app.domain_events',
  $$org_id in (select private.orgs_with_capability('org.webhooks.manage'))$$);

-- RPCs ------------------------------------------------------------------------------------------------------------------------

create or replace function app.transition_project(p_project_id uuid, p_expected app.project_state, p_next app.project_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_active bigint;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'projects.settings.write is required on the project';
  end if;
  if p_next in ('Proposed', 'Active', 'Blocked') and p_expected not in ('Proposed', 'Active', 'Blocked') then
    select p.org_id into v_org from app.projects p where p.id = p_project_id;
    perform 1 from app.organizations o where o.id = v_org for update;
    select count(*) into v_active from app.projects p
    where p.org_id = v_org and p.deleted_at is null and p.archived_at is null
      and p.project_state in ('Proposed', 'Active', 'Blocked');
    perform private.assert_within_plan_limit(v_org, 'active_projects', v_active + 1);
  end if;
  return private.transition_lifecycle('project', 'app.projects', 'project_state', 'app.project_state_transitions',
    'project_id', p_project_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_project(uuid, app.project_state, app.project_state, text) is 'Moves a project to another project state with compare-and-set on the expected state; needs projects.settings.write on the project. Reopening counts against the active_projects plan limit. Returns the ledger entry id.';

create or replace function app.transition_production(p_project_id uuid, p_expected app.production_state, p_next app.production_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'projects.settings.write is required on the project';
  end if;
  return private.transition_lifecycle('production', 'app.projects', 'production_state', 'app.production_state_transitions',
    'project_id', p_project_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_production(uuid, app.production_state, app.production_state, text) is 'Moves a project''s production to another production state with compare-and-set on the expected state; needs projects.settings.write on the project. Closed is terminal (invariant 10). Returns the ledger entry id.';

create or replace function app.pass_gate(p_project_id uuid, p_expected_phase text, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_gate integer;
  v_next text;
  v_unmet text;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'projects.gate.transition') then
    raise exception using errcode = '42501', message = 'projects.gate.transition is required on the project';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    perform private.refuse('transition_reason_required', 'Every gate transition carries a reason.');
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.current_phase_code is distinct from p_expected_phase then
    perform private.refuse('gate_phase_conflict',
      format('The project is in %s, not %s; reload and try again.', v_project.current_phase_code, p_expected_phase));
  end if;
  if v_project.project_state = 'Canceled' then
    perform private.refuse('project_canceled', 'A canceled project passes no gates.');
  end if;
  select ph.gate into v_gate from xpms.dim_phase ph where ph.phase_code = p_expected_phase;
  if exists (select 1 from app.project_phase_transitions t where t.project_id = p_project_id and t.gate = v_gate) then
    perform private.refuse('gate_already_passed', format('Gate %s has already been passed.', v_gate));
  end if;
  select string_agg(c.criterion_id, ', ' order by c.ordinal) into v_unmet
  from xpms.dim_gate_criterion c
  where c.gate = v_gate and c.is_blocking
    and not exists (
      select 1 from app.gate_evidence e
      where e.project_id = p_project_id and e.criterion_id = c.criterion_id
        and e.deleted_at is null and e.assertion_rank >= 1);
  if v_unmet is not null then
    perform private.refuse('gate_criteria_unmet',
      format('Gate %s needs evidence for every blocking criterion; missing: %s.', v_gate, v_unmet));
  end if;
  select ph.phase_code into v_next from xpms.dim_phase ph where ph.gate = v_gate + 1;

  if v_next is not null then
    perform private.begin_trusted_operation('project_phase_transition');
    update app.projects set current_phase_code = v_next where id = p_project_id;
    perform private.end_trusted_operation('project_phase_transition');
  end if;
  insert into app.project_phase_transitions (project_id, gate, from_phase_code, to_phase_code, reason)
  values (p_project_id, v_gate, p_expected_phase, v_next, btrim(p_reason));
  return coalesce(v_next, p_expected_phase);
end;
$$;

comment on function app.pass_gate(uuid, text, text) is 'Invariant 9: passes the gate that closes the expected current phase. Compare-and-set on the expected phase; refuses while any blocking criterion of the gate lacks evidence of assertion rank 1 or more. Gate 9 closes the last phase and leaves the project in CLS. Returns the phase the project is in afterwards.';

create or replace function app.create_counterparty(p_org_id uuid, p_name text, p_counterparty_type text, p_organization_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization uuid := p_organization_id;
  v_counterparty uuid;
  v_base text;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'vendors.vendor.write') then
    raise exception using errcode = '42501', message = 'vendors.vendor.write is required';
  end if;
  if v_organization is null then
    if p_name is null or char_length(btrim(p_name)) = 0 then
      perform private.refuse('counterparty_name_required', 'A new counterparty needs the company''s name.');
    end if;
    v_base := left(pg_catalog.btrim(regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '-', 'g'), '-'), 36);
    if char_length(v_base) < 2 then
      v_base := 'org';
    end if;
    insert into app.organizations (name, slug)
    values (btrim(p_name), v_base || '-' || encode(extensions.gen_random_bytes(4), 'hex'))
    returning id into v_organization;
  end if;
  insert into app.counterparties (org_id, organization_id, counterparty_type)
  values (p_org_id, v_organization, p_counterparty_type)
  returning id into v_counterparty;
  return v_counterparty;
end;
$$;

comment on function app.create_counterparty(uuid, text, text, uuid) is 'Records another company as a counterparty of the org: links an existing organization, or creates the organization identity row (Section 4.8.1) when none is given. Needs vendors.vendor.write. Returns the counterparty id.';

-- Views ---------------------------------------------------------------------------------------------------------------------------

create view app.gate_criteria_status with (security_invoker = true) as
select p.id as project_id, c.gate, c.criterion_id, c.is_blocking,
  count(e.id) filter (where e.assertion_rank >= 1) as evidence_count,
  max(e.assertion_rank) as best_assertion_rank,
  exists (select 1 from app.project_phase_transitions t where t.project_id = p.id and t.gate = c.gate) as gate_passed
from app.projects p
cross join xpms.dim_gate_criterion c
left join app.gate_evidence e on e.project_id = p.id and e.criterion_id = c.criterion_id and e.deleted_at is null
where p.deleted_at is null
group by p.id, c.gate, c.criterion_id, c.is_blocking, c.ordinal;

call private.describe('app.gate_criteria_status', 'Gate readiness per project and criterion, derived from the evidence spine. A criterion with no evidence of rank 1 or more is unmet.', array[
  'project_id', 'Project.',
  'gate', 'Gate of the criterion.',
  'criterion_id', 'Canon criterion.',
  'is_blocking', 'True when an unmet criterion stops the gate.',
  'evidence_count', 'Pieces of evidence of assertion rank 1 or more.',
  'best_assertion_rank', 'Highest assertion rank attested; NULL when nothing is attested.',
  'gate_passed', 'True once the project has passed the gate.'
]);

create view app.project_authority with (security_invoker = true) as
select p.id as project_id, ja.function as service, ja.agency, ja.contact
from app.projects p
join app.venues v on v.id = p.venue_id
join xpms.jurisdiction_agency ja on ja.jurisdiction_id = v.jurisdiction_id
join xpms.agency_function f on f.function = ja.function and f.responder
where p.deleted_at is null;

call private.describe('app.project_authority', 'Responding authorities for a project from its venue''s jurisdiction (engagement contract project_authority; decision D15).', array[
  'project_id', 'Project.',
  'service', 'Responding service the agency provides.',
  'agency', 'Agency name.',
  'contact', 'Agency contact.'
]);

revoke all on app.gate_criteria_status, app.project_authority from public, anon;
grant select on app.gate_criteria_status, app.project_authority to authenticated, service_role;

-- Function privileges ------------------------------------------------------------------------------------------------------------

revoke all on function app.counterparty_name(app.counterparties) from public, anon;
revoke all on function private.guard_scope_node() from public, anon, authenticated;
revoke all on function private.guard_gate_evidence() from public, anon, authenticated;
revoke all on function private.emit_event(uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.emit_row_event() from public, anon, authenticated;
revoke all on function private.my_project_ids() from public, anon;
revoke all on function private.project_ids_with(text) from public, anon;
revoke all on function private.readable_project_ids() from public, anon;
revoke all on function private.oversight_org_ids(text) from public, anon;
revoke all on function private.can_on_project(uuid, text) from public, anon, authenticated;
revoke all on function private.assert_production_open(uuid) from public, anon, authenticated;
revoke all on function private.guard_project() from public, anon, authenticated;
revoke all on function private.guard_project_member() from public, anon, authenticated;
revoke all on function app.transition_project(uuid, app.project_state, app.project_state, text) from public, anon;
revoke all on function app.transition_production(uuid, app.production_state, app.production_state, text) from public, anon;
revoke all on function app.pass_gate(uuid, text, text) from public, anon;
revoke all on function app.create_counterparty(uuid, text, text, uuid) from public, anon;

grant execute on function app.counterparty_name(app.counterparties) to authenticated, service_role;
grant execute on function private.my_project_ids() to authenticated, service_role;
grant execute on function private.project_ids_with(text) to authenticated, service_role;
grant execute on function private.readable_project_ids() to authenticated, service_role;
grant execute on function private.oversight_org_ids(text) to authenticated, service_role;
grant execute on function app.transition_project(uuid, app.project_state, app.project_state, text) to authenticated, service_role;
grant execute on function app.transition_production(uuid, app.production_state, app.production_state, text) to authenticated, service_role;
grant execute on function app.pass_gate(uuid, text, text) to authenticated, service_role;
grant execute on function app.create_counterparty(uuid, text, text, uuid) to authenticated, service_role;
