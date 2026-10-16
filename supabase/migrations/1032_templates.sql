-- 1032_templates.sql
-- A33 Platform workflow (RRR-77). Org templates (Section 4.10 workflow engine: "templates,
-- template_versions, template_applications"; Section 4.5.5 Projects > Templates; capability
-- projects.template.write "Create and edit project templates" and projects.project.create "Create a
-- project, including from a template").
--
--   * A template is an org's reusable starting point for a project. Its content lives in versions: a
--     version holds the project defaults (time zone, tier, region, jurisdiction, currency, length) and
--     ordered items, normalized one row per item (ADR 0002, no JSON documents): scope nodes (shows and
--     standing venues under the engagement root) and records (with a phase and a due date relative to
--     the project start).
--   * A version is edited while it is a draft and frozen once published; publishing makes it the
--     template's current version. Projects already created from an earlier version keep what they got.
--   * app.apply_template creates a project from the current version through app.create_project and
--     adds its scope nodes and records, all as the caller, so row level security and every guard of
--     those tables decide exactly as for a project built by hand. Each use is recorded in
--     template_applications.
--   * app.create_template_from_project saves a project's scope nodes and open records as a new
--     template with a published first version.
-- The XOS 4.0 Production Template copy of the canon (xpms.production_template) is the canon owner's
-- frozen mirror (ADR 0014 items 1, 5 and 7) and is not part of this table set.

create type app.template_kind as enum ('Project');
comment on type app.template_kind is 'What a template creates. Project templates create a project with its scope nodes and records.';

create type app.template_item_kind as enum ('Scope Node', 'Record');
comment on type app.template_item_kind is 'Kind of a template item: a scope node under the engagement root, or a record.';

insert into private.domain_event_types (code, subject, description) values
  ('template.published', 'template_versions', 'A template version was published and became the template''s current version.'),
  ('template.applied', 'template_applications', 'A project was created from a template.')
on conflict (code) do nothing;

-- Templates -----------------------------------------------------------------------------------------------

create table app.templates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  template_kind app.template_kind not null default 'Project',
  current_version_id uuid,
  deleted_at timestamptz,
  constraint templates_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint templates_description_length check (description is null or char_length(description) <= 2000)
);

create unique index templates_name_key on app.templates (org_id, lower(btrim(name))) where deleted_at is null;

call private.install_domain_table('app.templates');
call private.describe('app.templates', 'Org templates (Section 4.10): reusable starting points for projects. Content lives in template_versions; the current version is the latest published one.', array[
  'name', 'Template name, unique in the org.',
  'description', 'When to use the template.',
  'template_kind', 'What the template creates; Project.',
  'current_version_id', 'Latest published version, used when the template is applied; NULL until a version is published. Set only by app.publish_template_version.'
]);

call private.install_policies('app.templates',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);

-- Versions ------------------------------------------------------------------------------------------------

create table app.template_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  template_id uuid not null references app.templates (id),
  version_number integer not null default 0,
  notes text,
  default_time_zone text,
  default_tier_code text references xpms.dim_tier (tier_code),
  default_region_code text references xpms.dim_region (region_code),
  default_jurisdiction_id text references xpms.jurisdiction (jurisdiction_id),
  default_currency_code char(3) references private.currencies (currency_code),
  duration_days integer,
  published_at timestamptz,
  deleted_at timestamptz,
  constraint template_versions_notes_length check (notes is null or char_length(notes) <= 2000),
  constraint template_versions_duration check (duration_days is null or duration_days between 1 and 3660)
);

create index template_versions_template_idx on app.template_versions (template_id, version_number);
create index template_versions_tier_idx on app.template_versions (default_tier_code);
create index template_versions_region_idx on app.template_versions (default_region_code);
create index template_versions_jurisdiction_idx on app.template_versions (default_jurisdiction_id);
create index template_versions_currency_idx on app.template_versions (default_currency_code);
create unique index template_versions_number_key on app.template_versions (template_id, version_number);

alter table app.templates add constraint templates_current_version_fkey
  foreign key (current_version_id) references app.template_versions (id);
create index templates_current_version_idx on app.templates (current_version_id);

call private.install_domain_table('app.template_versions', 'app.templates', 'template_id');
call private.describe('app.template_versions', 'Versions of a template: project defaults and ordered items. Edited while a draft; frozen once published.', array[
  'template_id', 'Template the version belongs to.',
  'version_number', 'Version number, issued in order on insert, 1 first.',
  'notes', 'What changed in this version.',
  'default_time_zone', 'IANA time zone a new project starts with, when the person applying does not give one.',
  'default_tier_code', 'Canon tier a new project starts with.',
  'default_region_code', 'Canon region a new project starts with.',
  'default_jurisdiction_id', 'Canon jurisdiction a new project starts with.',
  'default_currency_code', 'ISO 4217 currency a new project starts with.',
  'duration_days', 'Length of the project in days; the end date is the start date plus this length less one day.',
  'published_at', 'When the version was published; NULL while it is a draft. Set only by app.publish_template_version.'
]);

create or replace function private.template_version_published(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v.published_at is not null from app.template_versions v where v.id = p_version_id;
$$;

comment on function private.template_version_published(uuid) is 'True when a template version is published (takes the version id as a value).';
revoke all on function private.template_version_published(uuid) from public, anon, authenticated;

create or replace function private.guard_template_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('template_publish') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.published_at is not null then
      perform private.refuse('template_version_publish_rpc', 'A version is published through app.publish_template_version.');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('template_versions:' || new.template_id::text, 0));
    new.version_number := coalesce((select max(v.version_number) from app.template_versions v where v.template_id = new.template_id), 0) + 1;
    if new.default_time_zone is not null then
      perform private.assert_time_zone(new.default_time_zone);
    end if;
    return new;
  end if;
  if old.published_at is not null
     and (to_jsonb(new) - array['deleted_at', 'updated_at', 'updated_by']) <> (to_jsonb(old) - array['deleted_at', 'updated_at', 'updated_by']) then
    perform private.refuse('template_version_published', 'A published version is frozen; create a new version to change the template.');
  end if;
  if new.published_at is distinct from old.published_at or new.version_number <> old.version_number then
    perform private.refuse('template_version_publish_rpc', 'A version is published through app.publish_template_version.');
  end if;
  if new.default_time_zone is not null then
    perform private.assert_time_zone(new.default_time_zone);
  end if;
  return new;
end;
$$;

comment on function private.guard_template_version() is 'Numbers versions in order, checks the time zone, refuses edits of a published version (it may still be deleted and restored) and publishing outside app.publish_template_version.';
revoke all on function private.guard_template_version() from public, anon, authenticated;

create trigger t40_guard_template_version before insert or update on app.template_versions
  for each row execute function private.guard_template_version();

call private.install_policies('app.template_versions',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);

-- Items ---------------------------------------------------------------------------------------------------

create table app.template_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  template_version_id uuid not null references app.template_versions (id),
  item_kind app.template_item_kind not null,
  sort_order integer not null,
  name text not null,
  scope_kind app.scope_kind,
  scope_code_suffix text,
  record_kind text references xpms.dim_record_kind (record_kind),
  xyz xpms.xyz_tag,
  phase_code text references xpms.dim_phase (phase_code),
  due_offset_days integer,
  deleted_at timestamptz,
  constraint template_items_sort_order check (sort_order between 1 and 10000),
  constraint template_items_name_length check (char_length(btrim(name)) between 1 and 200 and name = btrim(name)),
  constraint template_items_scope_node check (item_kind <> 'Scope Node' or (
    scope_kind in ('Standing Venue', 'Show') and scope_code_suffix is not null
    and record_kind is null and xyz is null and phase_code is null and due_offset_days is null)),
  constraint template_items_record check (item_kind <> 'Record' or (
    record_kind is not null and xyz is not null and scope_kind is null and scope_code_suffix is null)),
  constraint template_items_suffix_format check (scope_code_suffix is null or scope_code_suffix ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  constraint template_items_offset check (due_offset_days is null or due_offset_days between -3660 and 3660)
);

create index template_items_version_idx on app.template_items (template_version_id, sort_order);
create index template_items_record_kind_idx on app.template_items (record_kind);
create index template_items_phase_idx on app.template_items (phase_code);
create unique index template_items_suffix_key on app.template_items (template_version_id, scope_code_suffix)
  where scope_code_suffix is not null and deleted_at is null;

call private.install_domain_table('app.template_items', 'app.template_versions', 'template_version_id');
call private.describe('app.template_items', 'Items of a template version, in order: scope nodes created under the new project''s engagement root, and records created in the new project.', array[
  'template_version_id', 'Version the item belongs to.',
  'item_kind', 'Scope Node or Record.',
  'sort_order', 'Position in the version, 1 first.',
  'name', 'Scope node name, or record title.',
  'scope_kind', 'For a scope node: Show or Standing Venue.',
  'scope_code_suffix', 'For a scope node: code after the project key, such as E02 for {KEY}-E02. Unique in the version.',
  'record_kind', 'For a record: canon record kind.',
  'xyz', 'For a record: schema family tag (X Resource, Y Process, Z Timeline), declared.',
  'phase_code', 'For a record: canon phase the record belongs to, if any.',
  'due_offset_days', 'For a record: due this many days after the project start (negative for before); NULL for no due date.'
]);

create or replace function private.guard_template_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.template_version_published(new.template_version_id)
     or (tg_op = 'UPDATE' and private.template_version_published(old.template_version_id)) then
    perform private.refuse('template_version_published', 'A published version is frozen; create a new version to change the template.');
  end if;
  return new;
end;
$$;

comment on function private.guard_template_item() is 'Items change only while their version is a draft.';
revoke all on function private.guard_template_item() from public, anon, authenticated;

create trigger t40_guard_template_item before insert or update on app.template_items
  for each row execute function private.guard_template_item();

call private.install_policies('app.template_items',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.template.write'))$$);

-- Applications --------------------------------------------------------------------------------------------

create table app.template_applications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  template_id uuid not null references app.templates (id),
  template_version_id uuid not null references app.template_versions (id),
  project_id uuid not null references app.projects (id),
  scope_nodes_created integer not null default 0,
  records_created integer not null default 0,
  constraint template_applications_counts check (scope_nodes_created >= 0 and records_created >= 0)
);

create index template_applications_template_idx on app.template_applications (template_id);
create index template_applications_version_idx on app.template_applications (template_version_id);
create unique index template_applications_project_key on app.template_applications (project_id);

call private.install_domain_table('app.template_applications', 'app.templates', 'template_id',
  array['app.template_versions', 'template_version_id', 'app.projects', 'project_id'], true);
call private.describe('app.template_applications', 'Append-only record of each project created from a template, the version used and what it created. Written by app.apply_template.', array[
  'template_id', 'Template applied.',
  'template_version_id', 'Published version applied.',
  'project_id', 'Project created; one application per project.',
  'scope_nodes_created', 'Scope nodes created from the version.',
  'records_created', 'Records created from the version.'
]);

call private.install_policies('app.template_applications',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('projects.project.create'))
    and project_id in (select private.readable_project_ids())$$);

create trigger t90_emit_template_applied after insert on app.template_applications
  for each row execute function private.emit_subject_event('template.applied', 'template_applications', 'id',
    'template_id', 'template_version_id', 'project_id');

-- RPCs ----------------------------------------------------------------------------------------------------

create or replace function app.publish_template_version(p_template_version_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version app.template_versions;
begin
  perform private.require_person();
  select * into v_version from app.template_versions v where v.id = p_template_version_id and v.deleted_at is null for update;
  if v_version.id is null or not private.has_capability(v_version.org_id, 'projects.template.write') then
    raise exception using errcode = '42501', message = 'projects.template.write is required';
  end if;
  if v_version.published_at is not null then
    perform private.refuse('template_version_published', 'This version is already published.');
  end if;
  if (select t.deleted_at from app.templates t where t.id = v_version.template_id) is not null then
    perform private.refuse('template_deleted', 'Restore the template before publishing a version of it.');
  end if;
  perform private.begin_trusted_operation('template_publish');
  update app.template_versions set published_at = now() where id = v_version.id;
  update app.templates set current_version_id = v_version.id where id = v_version.template_id;
  perform private.end_trusted_operation('template_publish');
  perform private.emit_event(v_version.org_id, 'template.published', 'template_versions', v_version.id, null,
    jsonb_build_object('template_id', v_version.template_id, 'version_number', v_version.version_number));
  return v_version.id;
end;
$$;

comment on function app.publish_template_version(uuid) is 'Publishes a draft template version (projects.template.write): freezes it and makes it the template''s current version. Returns the version id.';
revoke all on function app.publish_template_version(uuid) from public, anon;
grant execute on function app.publish_template_version(uuid) to authenticated, service_role;

create or replace function private.guard_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.current_version_id is distinct from old.current_version_id and not private.in_trusted_operation('template_publish') then
    perform private.refuse('template_current_version_rpc', 'The current version changes when a version is published.');
  end if;
  return new;
end;
$$;

comment on function private.guard_template() is 'A template''s current version changes only through app.publish_template_version.';
revoke all on function private.guard_template() from public, anon, authenticated;

create trigger t40_guard_template before update on app.templates
  for each row execute function private.guard_template();

create or replace function private.guard_template_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.current_version_id is not null then
    perform private.refuse('template_current_version_rpc', 'The current version changes when a version is published.');
  end if;
  return new;
end;
$$;

comment on function private.guard_template_insert() is 'A new template has no current version until one is published.';
revoke all on function private.guard_template_insert() from public, anon, authenticated;

create trigger t40_guard_template_insert before insert on app.templates
  for each row execute function private.guard_template_insert();

create or replace function app.apply_template(
  p_template_id uuid,
  p_project_key text,
  p_name text,
  p_time_zone text default null,
  p_starts_on date default null,
  p_venue_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_template app.templates;
  v_version app.template_versions;
  v_project uuid;
  v_root uuid;
  v_key text := upper(btrim(p_project_key));
  v_zone text;
  v_item app.template_items;
  v_nodes integer := 0;
  v_records integer := 0;
  v_application uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_template from app.templates t where t.id = p_template_id and t.deleted_at is null;
  if v_template.id is null then
    raise exception using errcode = '42501', message = 'template not found';
  end if;
  if v_template.current_version_id is null then
    raise exception using errcode = 'XR001', hint = 'template_unpublished',
      message = 'template_unpublished: Publish a version of the template before creating projects from it.';
  end if;
  select * into v_version from app.template_versions v where v.id = v_template.current_version_id;
  v_zone := coalesce(nullif(btrim(p_time_zone), ''), v_version.default_time_zone);
  if v_zone is null then
    raise exception using errcode = 'XR001', hint = 'template_time_zone_required',
      message = 'template_time_zone_required: Choose the project''s time zone; the template does not set one.';
  end if;

  v_project := app.create_project(v_template.org_id, v_key, p_name, v_zone, v_version.default_jurisdiction_id,
    v_version.default_region_code, v_version.default_tier_code, p_venue_id, p_starts_on,
    case when p_starts_on is not null and v_version.duration_days is not null then p_starts_on + v_version.duration_days - 1 end,
    v_version.default_currency_code, v_template.description);
  select n.id into v_root from app.scope_nodes n where n.project_id = v_project and n.parent_id is null and n.deleted_at is null;

  for v_item in
    select * from app.template_items i
    where i.template_version_id = v_version.id and i.deleted_at is null
    order by i.sort_order, i.id
  loop
    if v_item.item_kind = 'Scope Node' then
      insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, venue_id)
      values (v_project, v_root, v_item.scope_kind, v_key || '-' || v_item.scope_code_suffix, v_item.name,
        case when v_item.scope_kind = 'Show' then p_venue_id end);
      v_nodes := v_nodes + 1;
    else
      insert into app.records (project_id, scope_node_id, record_kind, title, phase_code, xyz, xyz_basis, due_at, time_zone)
      values (v_project, v_root, v_item.record_kind, v_item.name, v_item.phase_code, v_item.xyz, 'Declared',
        case when p_starts_on is not null and v_item.due_offset_days is not null
          then ((p_starts_on + v_item.due_offset_days)::timestamp + time '17:00') at time zone v_zone end,
        v_zone);
      v_records := v_records + 1;
    end if;
  end loop;

  insert into app.template_applications (template_id, template_version_id, project_id, scope_nodes_created, records_created)
  values (v_template.id, v_version.id, v_project, v_nodes, v_records)
  returning id into v_application;
  return v_application;
end;
$$;

comment on function app.apply_template(uuid, text, text, text, date, uuid) is 'Creates a project from a template''s current version as the caller: app.create_project with the version''s defaults (the given time zone wins), then its scope nodes under the engagement root ({KEY}-{suffix}) and its records, due at 17:00 project time on the start date plus their offset. Row level security and the guards of every table decide. Records the application and returns its id.';
revoke all on function app.apply_template(uuid, text, text, text, date, uuid) from public, anon;
grant execute on function app.apply_template(uuid, text, text, text, date, uuid) to authenticated, service_role;

create or replace function app.create_template_from_project(p_project_id uuid, p_name text, p_description text default null)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project app.projects;
  v_template uuid;
  v_version uuid;
  v_order integer := 0;
  v_node record;
  v_record record;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  insert into app.templates (org_id, name, description) values (v_project.org_id, btrim(p_name), nullif(btrim(p_description), ''))
  returning id into v_template;
  insert into app.template_versions (template_id, notes, default_time_zone, default_tier_code, default_region_code,
    default_jurisdiction_id, default_currency_code, duration_days)
  values (v_template, 'Saved from project ' || v_project.project_key || '.', v_project.time_zone, v_project.tier_code,
    v_project.region_code, v_project.jurisdiction_id, v_project.currency,
    case when v_project.starts_on is not null and v_project.ends_on is not null then v_project.ends_on - v_project.starts_on + 1 end)
  returning id into v_version;
  for v_node in
    select n.scope_kind, n.scope_code, n.name from app.scope_nodes n
    where n.project_id = v_project.id and n.parent_id is not null and n.deleted_at is null
      and n.scope_kind in ('Standing Venue', 'Show')
      and n.scope_code like v_project.project_key || '-%'
    order by n.path
  loop
    v_order := v_order + 1;
    insert into app.template_items (template_version_id, item_kind, sort_order, name, scope_kind, scope_code_suffix)
    values (v_version, 'Scope Node', v_order, v_node.name, v_node.scope_kind,
      left(substr(v_node.scope_code, char_length(v_project.project_key) + 2), 16));
  end loop;
  for v_record in
    select r.record_kind, r.title, r.phase_code, r.xyz, r.due_at from app.records r
    where r.project_id = v_project.id and r.deleted_at is null and r.record_state not in ('Canceled', 'Complete')
    order by r.record_number
  loop
    v_order := v_order + 1;
    insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, phase_code, due_offset_days)
    values (v_version, 'Record', v_order, v_record.title, v_record.record_kind, v_record.xyz, v_record.phase_code,
      case when v_project.starts_on is not null and v_record.due_at is not null
        then greatest(least((v_record.due_at at time zone v_project.time_zone)::date - v_project.starts_on, 3660), -3660) end);
  end loop;
  perform app.publish_template_version(v_version);
  return v_template;
end;
$$;

comment on function app.create_template_from_project(uuid, text, text) is 'Saves a project as a new template, as the caller: its defaults, its show and standing venue scope nodes and its open records (due dates kept relative to the project start) become a published first version. Needs projects.template.write. Returns the template id.';
revoke all on function app.create_template_from_project(uuid, text, text) from public, anon;
grant execute on function app.create_template_from_project(uuid, text, text) to authenticated, service_role;

-- Retention and Trash ---------------------------------------------------------------------------------------

call private.install_default_retention('app.templates');
call private.install_default_retention('app.template_versions');
call private.install_default_retention('app.template_items');
call private.install_default_retention('app.template_applications');
select private.sync_trash_tables();
