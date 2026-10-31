-- 3030_event_types.sql
-- B14 Event types and project setup (RRR-238; parity gap G-250; ADR 0153 decisions D2 and D7; block 3030 to 3039). An
-- org's event types: each names a kind of event the org produces (a festival, a gala, a trade show), picks the
-- template a new project starts from by its scale and audience bands, and carries a set of project custom fields
-- (A117) that intake shows, some required by a gate (3032).
--
--   * app.event_scale and app.event_audience: the bands chosen at intake. They are facts about the event the project
--     stores, never derived (D2).
--   * app.event_types: read by the org's members, written with projects.template.write (D7). A type a live project
--     names is archived, never deleted (event_type_in_use); an archived type is hidden from intake and cannot be newly
--     set on a project (event_type_archived).
--   * app.event_type_templates: which template a type starts from for a (scale, audience) pair; NULL means any. The
--     most specific live row whose template is live and published wins (private.resolve_event_type_template).
--   * app.event_type_fields: the type's field set, the A117 project fields intake shows. A field marked
--     required_for_type must hold a value before the gate named by required_by_gate passes (3032).
--   * app.projects gains event_type_id, event_scale and event_audience. Setting them on a project that has none needs
--     only the project update policy (projects.project.write), so intake's own update passes for every role that
--     creates projects; changing or clearing them needs projects.settings.write (project_event_type_locked; t44, ADR 0153 C3).
--   * app.resolve_event_type_template wraps the resolver for invokers, which have no usage on schema private.
--   * private.emit_project_update names the three columns in project.updated (additive to the webhook payload).
-- Event types come back from Trash (ADR 0110); the template rules and field set are configuration children that go
-- with their type and stay out. No view is created, so 1650's xos_backup rule does not apply.

-- Bands ------------------------------------------------------------------------------------------------------------------

create type app.event_scale as enum ('Intimate', 'Small', 'Medium', 'Large', 'Major');
comment on type app.event_scale is 'Expected attendance band of an event, chosen at intake (G-250, ADR 0153 D2): Intimate (up to 500 people), Small (500 to 2,500), Medium (2,500 to 10,000), Large (10,000 to 50,000) and Major (over 50,000). Each band includes its upper bound.';

create type app.event_audience as enum ('Public Ticketed', 'Public Free', 'Invite Only', 'Trade', 'Internal');
comment on type app.event_audience is 'Who attends an event, chosen at intake (G-250, ADR 0153 D2): Public Ticketed (the public, with tickets), Public Free (the public, free entry), Invite Only (guests on a list), Trade (industry and press) and Internal (the org''s own people or a client''s staff).';

-- Event types --------------------------------------------------------------------------------------------------------------

create table app.event_types (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  intake_guidance text,
  sort_order integer not null default 100,
  retired_at timestamptz,
  deleted_at timestamptz,
  constraint event_types_name_length check (char_length(name) between 1 and 100 and name = btrim(name)),
  constraint event_types_description_length check (description is null or char_length(description) between 1 and 2000),
  constraint event_types_guidance_length check (intake_guidance is null or char_length(intake_guidance) between 1 and 2000),
  constraint event_types_sort_order check (sort_order between 1 and 10000)
);

call private.install_domain_table('app.event_types');
create unique index event_types_name_key on app.event_types (org_id, lower(btrim(name))) where deleted_at is null;
call private.describe('app.event_types', 'Event types of an org (G-250, ADR 0153 D2): the kinds of event it produces. Each picks the template a new project starts from by scale and audience (app.event_type_templates), carries the project fields intake shows (app.event_type_fields) and the document types a project of the type needs (app.event_type_document_requirements). Read by the org''s members; written with projects.template.write.', array[
  'name', 'Name of the type, unique in the org, such as Music Festival.',
  'description', 'What events of this type are, shown on the intake cards.',
  'intake_guidance', 'What to have ready at intake, shown beside the type''s fields.',
  'sort_order', 'Position among the org''s types, 1 first (1 to 10000).',
  'retired_at', 'When the type was archived; an archived type is hidden from intake and is not newly set on a project, and projects that name it keep it.'
]);

create or replace function private.guard_event_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null
     and exists (select 1 from app.projects p where p.event_type_id = new.id and p.deleted_at is null) then
    perform private.refuse('event_type_in_use', 'Archive the event type instead; projects still use it.');
  end if;
  return new;
end;
$$;

comment on function private.guard_event_type() is 'Event types: a type a live project names is archived, never deleted (event_type_in_use).';
revoke all on function private.guard_event_type() from public, anon, authenticated;

create trigger t40_guard_event_type before update of deleted_at on app.event_types
  for each row execute function private.guard_event_type();

call private.install_policies('app.event_types',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.event_types');
call private.install_audit_trail('app.event_types');

-- Template rules -------------------------------------------------------------------------------------------------------------

create table app.event_type_templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  event_type_id uuid not null references app.event_types (id),
  event_scale app.event_scale,
  event_audience app.event_audience,
  template_id uuid not null references app.templates (id),
  deleted_at timestamptz
);

create unique index event_type_templates_band_key on app.event_type_templates (event_type_id, event_scale, event_audience)
  nulls not distinct where deleted_at is null;
create index event_type_templates_template_idx on app.event_type_templates (template_id);

call private.install_domain_table('app.event_type_templates', 'app.event_types', 'event_type_id',
  array['app.templates', 'template_id']);
call private.describe('app.event_type_templates', 'Which template a project of an event type starts from, by scale and audience band (G-250, ADR 0153 D2). NULL in a band means any. The most specific live rule whose template is live and published wins: (scale, audience), then (scale, any), then (any, audience), then (any, any); with none, the project starts blank.', array[
  'event_type_id', 'Event type the rule belongs to.',
  'event_scale', 'Scale band the rule applies to; NULL applies to any scale.',
  'event_audience', 'Audience band the rule applies to; NULL applies to any audience.',
  'template_id', 'Project template a matching project starts from.'
]);

create or replace function private.guard_event_type_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and not exists (
      select 1 from app.templates t
      where t.id = new.template_id and t.deleted_at is null and t.template_kind = 'Project') then
    perform private.refuse('event_type_template_kind', 'Choose a live project template.');
  end if;
  if tg_op = 'UPDATE' and new.event_type_id <> old.event_type_id then
    perform private.refuse('event_type_template_type_immutable', 'A template rule stays with its event type; add the rule to the other type instead.');
  end if;
  return new;
end;
$$;

comment on function private.guard_event_type_template() is 'Event type template rules: the template is a live project template (event_type_template_kind), and a rule keeps its type (event_type_template_type_immutable).';
revoke all on function private.guard_event_type_template() from public, anon, authenticated;

create trigger t40_guard_event_type_template before insert or update on app.event_type_templates
  for each row execute function private.guard_event_type_template();

call private.install_policies('app.event_type_templates',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.event_type_templates');
call private.install_audit_trail('app.event_type_templates');

-- Field sets -------------------------------------------------------------------------------------------------------------------

create table app.event_type_fields (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  event_type_id uuid not null references app.event_types (id),
  custom_field_definition_id uuid not null references app.custom_field_definitions (id),
  required_for_type boolean not null default false,
  required_by_gate integer not null default 1 references xpms.dim_phase (gate),
  sort_order integer not null default 100,
  deleted_at timestamptz,
  constraint event_type_fields_sort_order check (sort_order between 1 and 10000)
);

create unique index event_type_fields_field_key on app.event_type_fields (event_type_id, custom_field_definition_id)
  where deleted_at is null;
create index event_type_fields_definition_idx on app.event_type_fields (custom_field_definition_id);
create index event_type_fields_gate_idx on app.event_type_fields (required_by_gate);

call private.install_domain_table('app.event_type_fields', 'app.event_types', 'event_type_id',
  array['app.custom_field_definitions', 'custom_field_definition_id']);
call private.describe('app.event_type_fields', 'The field set of an event type (G-250, ADR 0153 D3): the A117 project custom fields intake shows for a project of the type, Visible or Required. A field required for the type must hold a value before the gate named by required_by_gate passes (app.pass_gate, 3032).', array[
  'event_type_id', 'Event type the field belongs to.',
  'custom_field_definition_id', 'Project custom field (A117) shown at intake.',
  'required_for_type', 'True when a project of the type must give the field a value; false shows it without requiring it.',
  'required_by_gate', 'Gate (1 to 9) that refuses to pass while the field is empty; meaningful only when required_for_type.',
  'sort_order', 'Position in the intake form, 1 first (1 to 10000).'
]);

create or replace function private.guard_event_type_field()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and not exists (
      select 1 from app.custom_field_definitions d
      where d.id = new.custom_field_definition_id and d.deleted_at is null and d.target_table = 'app.projects') then
    perform private.refuse('event_type_field_target', 'Choose a live custom field of projects.');
  end if;
  if tg_op = 'UPDATE' and (new.event_type_id <> old.event_type_id
      or new.custom_field_definition_id <> old.custom_field_definition_id) then
    perform private.refuse('event_type_field_immutable', 'A field of a type keeps its type and field; remove it and add another.');
  end if;
  return new;
end;
$$;

comment on function private.guard_event_type_field() is 'Event type fields: the field is a live custom field of app.projects (event_type_field_target), and a row keeps its type and field (event_type_field_immutable).';
revoke all on function private.guard_event_type_field() from public, anon, authenticated;

create trigger t40_guard_event_type_field before insert or update on app.event_type_fields
  for each row execute function private.guard_event_type_field();

call private.install_policies('app.event_type_fields',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);
call private.install_default_retention('app.event_type_fields');
call private.install_audit_trail('app.event_type_fields');

-- Projects carry their type and bands ------------------------------------------------------------------------------------------

alter table app.projects
  add column event_type_id uuid references app.event_types (id),
  add column event_scale app.event_scale,
  add column event_audience app.event_audience;

create index projects_event_type_idx on app.projects (event_type_id);
call private.add_cross_org_references('app.projects', array['app.event_types', 'event_type_id']);

comment on column app.projects.event_type_id is 'Event type of the project, chosen at intake (G-250); NULL means no type, and the project behaves as before.';
comment on column app.projects.event_scale is 'Expected attendance band, chosen at intake; NULL when not given.';
comment on column app.projects.event_audience is 'Who attends, chosen at intake; NULL when not given.';

create or replace function private.guard_project_event_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type_id is not null
     and (tg_op = 'INSERT' or new.event_type_id is distinct from old.event_type_id)
     and not exists (select 1 from app.event_types t
                     where t.id = new.event_type_id and t.deleted_at is null and t.retired_at is null) then
    perform private.refuse('event_type_archived', 'This event type is archived; choose another.');
  end if;
  if tg_op = 'UPDATE' and auth.uid() is not null
     and (new.event_type_id is distinct from old.event_type_id or new.event_scale is distinct from old.event_scale
          or new.event_audience is distinct from old.event_audience)
     and (old.event_type_id is not null or old.event_scale is not null or old.event_audience is not null)
     and not private.can_on_project(new.id, 'projects.settings.write') then
    perform private.refuse('project_event_type_locked',
      'Only someone who may change the project''s settings changes its event type, scale or audience.');
  end if;
  return new;
end;
$$;

comment on function private.guard_project_event_type() is 'A project''s event type and bands (G-250, ADR 0153 C3): a type newly set must be live and not archived (event_type_archived). Setting them while all three are empty needs only the project update policy, so intake passes for every role that creates projects; changing or clearing a value needs projects.settings.write on the project (project_event_type_locked). Inserts and platform calls with no session pass.';
revoke all on function private.guard_project_event_type() from public, anon, authenticated;

create trigger t44_guard_project_event_type before insert or update of event_type_id, event_scale, event_audience on app.projects
  for each row execute function private.guard_project_event_type();

-- Template resolution ------------------------------------------------------------------------------------------------------------

create or replace function private.resolve_event_type_template(
  p_event_type_id uuid,
  p_scale app.event_scale,
  p_audience app.event_audience
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.template_id
  from app.event_type_templates r
  join app.event_types t on t.id = r.event_type_id and t.deleted_at is null
  join app.templates tp on tp.id = r.template_id and tp.deleted_at is null and tp.template_kind = 'Project'
    and tp.current_version_id is not null
  where r.event_type_id = p_event_type_id and r.deleted_at is null
    and t.org_id in (select private.my_org_ids())
    and (r.event_scale is null or r.event_scale = p_scale)
    and (r.event_audience is null or r.event_audience = p_audience)
  order by (r.event_scale is not null) desc, (r.event_audience is not null) desc
  limit 1;
$$;

comment on function private.resolve_event_type_template(uuid, app.event_scale, app.event_audience) is 'The template a project of the event type starts from for a scale and audience (G-250, ADR 0153 D2): among the type''s live rules that match (a NULL band matches any value) and whose template is a live, published project template, the most specific one, (scale, audience) before (scale, any) before (any, audience) before (any, any). NULL when none matches, when every match is unpublished, or when the type is not in one of the caller''s orgs.';
revoke all on function private.resolve_event_type_template(uuid, app.event_scale, app.event_audience) from public, anon;
grant execute on function private.resolve_event_type_template(uuid, app.event_scale, app.event_audience) to authenticated, service_role;

-- Invokers have no usage on schema private, so app.create_project_from_intake (3038), an invoker like apply_template,
-- resolves through this wrapper.
create or replace function app.resolve_event_type_template(
  p_event_type_id uuid,
  p_scale app.event_scale,
  p_audience app.event_audience
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.resolve_event_type_template(p_event_type_id, p_scale, p_audience);
$$;

comment on function app.resolve_event_type_template(uuid, app.event_scale, app.event_audience) is 'The template a project of the event type starts from for a scale and audience, as private.resolve_event_type_template answers it (G-250, ADR 0153 D2); NULL when none matches or the type is not in one of the caller''s orgs.';
revoke all on function app.resolve_event_type_template(uuid, app.event_scale, app.event_audience) from public, anon;
grant execute on function app.resolve_event_type_template(uuid, app.event_scale, app.event_audience) to authenticated, service_role;

-- project.updated names the type and bands -------------------------------------------------------------------------------------
-- Restated from 0401, its latest definition, with the three columns added. t91 fires after every update of
-- app.projects (0400), so the trigger does not change.

create or replace function private.emit_project_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := array[]::text[];
  v_data jsonb;
begin
  if new.archived_at is distinct from old.archived_at then
    perform private.emit_event(new.org_id,
      case when new.archived_at is null then 'project.restored' else 'project.archived' end,
      'projects', new.id, new.id, jsonb_build_object('project_key', new.project_key, 'name', new.name));
  end if;
  if new.project_key <> old.project_key then v_changed := array_append(v_changed, 'project_key'); end if;
  if new.name <> old.name then v_changed := array_append(v_changed, 'name'); end if;
  if new.description is distinct from old.description then v_changed := array_append(v_changed, 'description'); end if;
  if new.currency is distinct from old.currency then v_changed := array_append(v_changed, 'currency'); end if;
  if new.starts_on is distinct from old.starts_on then v_changed := array_append(v_changed, 'starts_on'); end if;
  if new.ends_on is distinct from old.ends_on then v_changed := array_append(v_changed, 'ends_on'); end if;
  if new.venue_id is distinct from old.venue_id then v_changed := array_append(v_changed, 'venue_id'); end if;
  if new.jurisdiction_id is distinct from old.jurisdiction_id then v_changed := array_append(v_changed, 'jurisdiction_id'); end if;
  if new.region_code is distinct from old.region_code then v_changed := array_append(v_changed, 'region_code'); end if;
  if new.tier_code is distinct from old.tier_code then v_changed := array_append(v_changed, 'tier_code'); end if;
  if new.time_zone <> old.time_zone then v_changed := array_append(v_changed, 'time_zone'); end if;
  if new.event_type_id is distinct from old.event_type_id then v_changed := array_append(v_changed, 'event_type_id'); end if;
  if new.event_scale is distinct from old.event_scale then v_changed := array_append(v_changed, 'event_scale'); end if;
  if new.event_audience is distinct from old.event_audience then v_changed := array_append(v_changed, 'event_audience'); end if;
  if cardinality(v_changed) > 0 then
    select jsonb_object_agg(c, to_jsonb(new) -> c) into v_data from unnest(v_changed) c;
    perform private.emit_event(new.org_id, 'project.updated', 'projects', new.id, new.id,
      jsonb_build_object('changed', to_jsonb(v_changed), 'values', v_data, 'project_key', new.project_key));
  end if;
  return null;
end;
$$;

comment on function private.emit_project_update() is 'After update trigger on app.projects: emits project.archived or project.restored, and project.updated naming the changed header columns with their new values, the event type and bands among them (3030). State and phase changes are emitted from their ledgers by 0301.';
revoke all on function private.emit_project_update() from public, anon, authenticated;

-- Removed event types belong in Trash (ADR 0110); their template rules and field set go with them.
insert into private.trash_excluded_tables (table_name, rationale) values
  ('event_type_templates', 'Template rules are configuration of their event type; they go with the type and are set again in its editor.'),
  ('event_type_fields', 'An event type''s field set is configuration of the type; it goes with the type and is set again in its editor.');
select private.sync_trash_tables();
