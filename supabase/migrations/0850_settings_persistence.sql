-- 0850_settings_persistence.sql
-- A30 Identity, Profiles and Settings (ADR 0022 range 0850 to 0899). Settings persistence for the
-- Wave 2 exit (RRR-73, ADR 0017 items 5 and 6):
--   * app.legal_acceptances, an append-only acceptance log written by app.record_legal_acceptances
--     (Section 14.4: document, version, time, IP and user), replacing user-writable auth metadata
--   * the settings registry in the database: private.setting_definitions and private.setting_choices,
--     filled by each contributor's own migration through private.define_setting (ADR 0021 pattern),
--     app.setting_values for org, workspace, team and project scopes with the org lock, and
--     app.personal_setting_values for the person's own settings (Section 4.5.6 precedence)
--   * app.resolve_settings, which answers every setting with its value and the scope it came from
--   * app.org_brands, app.org_domains and app.org_module_states (Section 12, Section 4.5.2)
--   * app.favorites, a person's pinned pages and records in an org
--   * the org-brand storage bucket for logos, favicons and app icons
--   * api_public.org_brand_for_host and api_public.org_brand_for_slug, the anonymous brand lookups
--     Gateway and the sign-in pages use for white label (Section 4.4.7)
--
-- Refusals use SQLSTATE XR001 through private.refuse. ADR 0016 item 14: every policy helper here takes
-- column values and reads tables other than the one its policy protects.

-- Enums ---------------------------------------------------------------------------------------------------

create type app.setting_value_type as enum ('Text', 'Boolean', 'Integer', 'Choice');
comment on type app.setting_value_type is 'Type of a registered setting; the value is stored in the matching typed column (Choice and Text in value_text).';

create type app.setting_scope as enum ('Organization', 'Workspace', 'Team', 'Project');
comment on type app.setting_scope is 'Shared scopes a setting value can be stored at, widest first (Section 4.5.6). Personal values live in app.personal_setting_values.';

create type app.setting_source as enum ('Personal', 'Project', 'Team', 'Workspace', 'Organization', 'Default');
comment on type app.setting_source is 'Where a resolved setting value comes from, most specific first (Section 4.5.6): every settings page shows it.';

create type app.org_domain_purpose as enum ('Atlas', 'Gateway', 'Email Sending', 'Verified Domain');
comment on type app.org_domain_purpose is 'What an org domain is for (Section 12, Section 4.8.3): a custom Atlas or Gateway host, an email sending domain, or a verified domain that earns the badge and allows automatic join.';

create type app.domain_verification_state as enum ('Pending', 'Verified', 'Failed');
comment on type app.domain_verification_state is 'DNS verification state of an org domain. Only the platform verification service changes it.';

create type app.brand_radius_scale as enum ('Compact', 'Default', 'Rounded');
comment on type app.brand_radius_scale is 'Corner radius scale a brand may choose (Section 12); each maps to a token set in @xos/tokens.';

-- Legal acceptances ------------------------------------------------------------------------------------------

create table app.legal_acceptances (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  person_id uuid not null references app.people (id),
  user_id uuid not null,
  document_slug text not null,
  document_version text not null,
  accepted_at timestamptz not null default now(),
  ip inet,
  constraint legal_acceptances_slug_format check (document_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(document_slug) <= 80),
  constraint legal_acceptances_version_format check (document_version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-z.]+)?$')
);

create index legal_acceptances_person_idx on app.legal_acceptances (person_id, document_slug);
create index legal_acceptances_document_idx on app.legal_acceptances (document_slug, document_version);

call private.install_domain_table('app.legal_acceptances', null, null, '{}', true);
call private.describe('app.legal_acceptances', 'Append-only log of legal document acceptances (Section 14.4): who accepted which version of which document, when and from which IP, and for which org when accepted on its behalf. Written only by app.record_legal_acceptances; never updated or deleted.', array[
  'org_id', 'Org the acceptance binds, when accepted on its behalf (for example the Terms of Service and DPA at signup); NULL for a personal acceptance such as the Worker Terms.',
  'person_id', 'Person who accepted.',
  'user_id', 'Sign-in the person used, kept as evidence even after the sign-in is deleted.',
  'document_slug', 'Legal document slug from legal/index.yaml, as published at /legal/{slug}.',
  'document_version', 'Semantic version of the document text accepted.',
  'accepted_at', 'When the acceptance was recorded. Set by the database.',
  'ip', 'Client IP address the acceptance came from, as reported by the platform server or seen by the database.'
]);

create or replace function private.stamp_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.accepted_at := now();
  return new;
end;
$$;

comment on function private.stamp_legal_acceptance() is 'Before insert: acceptance time comes from the database, so evidence cannot be backdated.';
revoke all on function private.stamp_legal_acceptance() from public, anon, authenticated;

create trigger t40_stamp_legal_acceptance before insert on app.legal_acceptances
  for each row execute function private.stamp_legal_acceptance();

call private.install_policies('app.legal_acceptances',
  $$person_id = (select private.current_person_id())
    or (org_id is not null and org_id in (select private.orgs_with_capability('org.legal.read')))$$);

create or replace function app.record_legal_acceptances(
  p_org_id uuid,
  p_document_slugs text[],
  p_document_versions text[],
  p_client_ip inet default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_user uuid := (select auth.uid());
  v_count integer;
begin
  if coalesce(cardinality(p_document_slugs), 0) = 0
     or cardinality(p_document_slugs) <> coalesce(cardinality(p_document_versions), 0) then
    perform private.refuse('legal_acceptance_documents', 'Name each accepted document once with its version.');
  end if;
  if p_org_id is not null and not private.has_capability(p_org_id, 'org.legal.accept') then
    raise exception using errcode = '42501', message = 'org.legal.accept is required to accept for an org';
  end if;
  insert into app.legal_acceptances (org_id, person_id, user_id, document_slug, document_version, ip)
  select p_org_id, v_person, v_user, d.slug, d.version, coalesce(p_client_ip, private.request_ip())
  from unnest(p_document_slugs, p_document_versions) as d (slug, version);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.record_legal_acceptances(uuid, text[], text[], inet) is 'Records that the signed-in person accepted the named versions of legal documents (Section 14.4), personally or for an org (needs org.legal.accept). The client IP comes from the platform server, or from the request when absent. Returns the number of acceptances recorded.';
revoke all on function app.record_legal_acceptances(uuid, text[], text[], inet) from public, anon;
grant execute on function app.record_legal_acceptances(uuid, text[], text[], inet) to authenticated, service_role;

create view app.current_legal_acceptances
with (security_invoker = true) as
select distinct on (a.person_id, a.org_id, a.document_slug)
  a.person_id, a.org_id, a.document_slug, a.document_version, a.accepted_at
from app.legal_acceptances a
where a.deleted_at is null
order by a.person_id, a.org_id, a.document_slug, a.accepted_at desc, a.id desc;

call private.describe('app.current_legal_acceptances', 'The latest accepted version of each document per person and org, for re-acceptance prompts after a material change and for Settings > Legal.', array[
  'person_id', 'Person who accepted.',
  'org_id', 'Org the acceptance binds; NULL for a personal acceptance.',
  'document_slug', 'Legal document slug.',
  'document_version', 'Latest version accepted.',
  'accepted_at', 'When that version was accepted.'
]);
revoke all on app.current_legal_acceptances from public, anon;
grant select on app.current_legal_acceptances to authenticated, service_role;

-- Settings registry -------------------------------------------------------------------------------------------
-- Definitions are platform reference data. Each contributor declares its settings in its own YAML file under
-- packages/schemas/settings/ and its own migration calls private.define_setting with the generated SQL, so no
-- shared list is edited (ADR 0021).

create table private.setting_definitions (
  setting_key text primary key,
  value_type app.setting_value_type not null,
  capability_code text not null references app.capabilities (code),
  allows_organization boolean not null,
  allows_workspace boolean not null,
  allows_team boolean not null,
  allows_project boolean not null,
  allows_personal boolean not null,
  lockable boolean not null,
  default_text text,
  default_boolean boolean,
  default_integer bigint,
  min_integer bigint,
  max_integer bigint,
  max_length integer,
  constraint setting_definitions_key_format check (setting_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(setting_key) <= 120),
  constraint setting_definitions_some_scope check (allows_organization or allows_workspace or allows_team or allows_project or allows_personal),
  constraint setting_definitions_lock_at_org check (not lockable or allows_organization),
  constraint setting_definitions_default_type check (
    case value_type
      when 'Boolean' then default_text is null and default_integer is null
      when 'Integer' then default_text is null and default_boolean is null
      else default_boolean is null and default_integer is null
    end),
  constraint setting_definitions_integer_bounds check (
    (value_type = 'Integer' or (min_integer is null and max_integer is null))
    and (min_integer is null or max_integer is null or min_integer <= max_integer)),
  constraint setting_definitions_max_length check (
    max_length is null or (value_type = 'Text' and max_length between 1 and 4000))
);

comment on table private.setting_definitions is 'Every setting the platform knows (Section 4.5.6): its type, the scopes it can be set at, the capability that edits it, whether the org can lock it and its platform default. Rows come only from private.define_setting, called by each contributor''s migration from its registry file.';
comment on column private.setting_definitions.setting_key is 'Setting key, dotted and lowercase, for example org.localization.time_zone.';
comment on column private.setting_definitions.value_type is 'Value type; decides which typed column holds values.';
comment on column private.setting_definitions.capability_code is 'Capability that edits the setting at a shared scope. Personal values are edited by their owner.';
comment on column private.setting_definitions.allows_organization is 'True when the setting can be set for the whole org.';
comment on column private.setting_definitions.allows_workspace is 'True when a workspace may override it.';
comment on column private.setting_definitions.allows_team is 'True when a team may override it.';
comment on column private.setting_definitions.allows_project is 'True when a project may override it.';
comment on column private.setting_definitions.allows_personal is 'True when each person may set it for themselves.';
comment on column private.setting_definitions.lockable is 'True when the org can lock its value so no lower scope overrides it.';
comment on column private.setting_definitions.default_text is 'Platform default of a Text or Choice setting.';
comment on column private.setting_definitions.default_boolean is 'Platform default of a Boolean setting.';
comment on column private.setting_definitions.default_integer is 'Platform default of an Integer setting.';
comment on column private.setting_definitions.min_integer is 'Smallest allowed Integer value.';
comment on column private.setting_definitions.max_integer is 'Largest allowed Integer value.';
comment on column private.setting_definitions.max_length is 'Longest allowed Text value in characters.';

create index setting_definitions_capability_code_idx on private.setting_definitions (capability_code);

alter table private.setting_definitions enable row level security;
revoke all on private.setting_definitions from public, anon, authenticated;
grant select on private.setting_definitions to service_role;

create table private.setting_choices (
  setting_key text not null references private.setting_definitions (setting_key) on delete cascade,
  choice text not null,
  sort_order smallint not null,
  primary key (setting_key, choice),
  constraint setting_choices_format check (choice ~ '^[A-Za-z0-9][A-Za-z0-9_./+:-]*$' and char_length(choice) <= 80)
);

comment on table private.setting_choices is 'Allowed values of each Choice setting, in display order. Labels come from the i18n catalogs keyed by setting key and choice.';
comment on column private.setting_choices.setting_key is 'Choice setting.';
comment on column private.setting_choices.choice is 'Stored value.';
comment on column private.setting_choices.sort_order is 'Display order.';

alter table private.setting_choices enable row level security;
revoke all on private.setting_choices from public, anon, authenticated;
grant select on private.setting_choices to service_role;

create or replace function private.define_setting(
  p_setting_key text,
  p_value_type app.setting_value_type,
  p_capability_code text,
  p_scopes text[],
  p_lockable boolean default false,
  p_default_text text default null,
  p_default_boolean boolean default null,
  p_default_integer bigint default null,
  p_choices text[] default null,
  p_min_integer bigint default null,
  p_max_integer bigint default null,
  p_max_length integer default null
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if exists (select 1 from unnest(p_scopes) s where s not in ('organization', 'workspace', 'team', 'project', 'personal')) then
    raise exception using errcode = '22023', message = format('unknown scope in %s', p_scopes);
  end if;
  insert into private.setting_definitions (
    setting_key, value_type, capability_code, allows_organization, allows_workspace, allows_team,
    allows_project, allows_personal, lockable, default_text, default_boolean, default_integer,
    min_integer, max_integer, max_length)
  values (
    p_setting_key, p_value_type, p_capability_code, 'organization' = any (p_scopes), 'workspace' = any (p_scopes),
    'team' = any (p_scopes), 'project' = any (p_scopes), 'personal' = any (p_scopes), p_lockable,
    p_default_text, p_default_boolean, p_default_integer, p_min_integer, p_max_integer, p_max_length)
  on conflict (setting_key) do update set
    value_type = excluded.value_type, capability_code = excluded.capability_code,
    allows_organization = excluded.allows_organization, allows_workspace = excluded.allows_workspace,
    allows_team = excluded.allows_team, allows_project = excluded.allows_project,
    allows_personal = excluded.allows_personal, lockable = excluded.lockable,
    default_text = excluded.default_text, default_boolean = excluded.default_boolean,
    default_integer = excluded.default_integer, min_integer = excluded.min_integer,
    max_integer = excluded.max_integer, max_length = excluded.max_length;
  delete from private.setting_choices c where c.setting_key = p_setting_key;
  if p_value_type = 'Choice' then
    if coalesce(cardinality(p_choices), 0) = 0 then
      raise exception using errcode = '22023', message = format('choice setting %s needs choices', p_setting_key);
    end if;
    insert into private.setting_choices (setting_key, choice, sort_order)
    select p_setting_key, c.choice, c.ord from unnest(p_choices) with ordinality as c (choice, ord);
    if p_default_text is not null and not (p_default_text = any (p_choices)) then
      raise exception using errcode = '22023', message = format('default of %s is not one of its choices', p_setting_key);
    end if;
  end if;
end;
$$;

comment on function private.define_setting(text, app.setting_value_type, text, text[], boolean, text, boolean, bigint, text[], bigint, bigint, integer) is 'Declares or redeclares one setting with its scopes (organization, workspace, team, project, personal), capability, lock, default and choices. Called by migrations from the generated registry SQL; idempotent.';
revoke all on function private.define_setting(text, app.setting_value_type, text, text[], boolean, text, boolean, bigint, text[], bigint, bigint, integer) from public, anon, authenticated;

create view app.setting_definitions as
select d.setting_key, d.value_type, d.capability_code, d.allows_organization, d.allows_workspace, d.allows_team,
  d.allows_project, d.allows_personal, d.lockable, d.default_text, d.default_boolean, d.default_integer,
  d.min_integer, d.max_integer, d.max_length
from private.setting_definitions d;

call private.describe('app.setting_definitions', 'Registered settings with their type, scopes, capability, lock and default, so settings pages offer only what the database accepts.', array[
  'setting_key', 'Setting key.', 'value_type', 'Value type.', 'capability_code', 'Capability that edits it at a shared scope.',
  'allows_organization', 'Settable for the org.', 'allows_workspace', 'Overridable per workspace.', 'allows_team', 'Overridable per team.',
  'allows_project', 'Overridable per project.', 'allows_personal', 'Settable per person.', 'lockable', 'The org can lock it.',
  'default_text', 'Text or Choice default.', 'default_boolean', 'Boolean default.', 'default_integer', 'Integer default.',
  'min_integer', 'Smallest Integer value.', 'max_integer', 'Largest Integer value.', 'max_length', 'Longest Text value.'
]);
revoke all on app.setting_definitions from public, anon;
grant select on app.setting_definitions to authenticated, service_role;

create view app.setting_choices as
select c.setting_key, c.choice, c.sort_order from private.setting_choices c;

call private.describe('app.setting_choices', 'Allowed values of each Choice setting, in display order.', array[
  'setting_key', 'Choice setting.', 'choice', 'Stored value.', 'sort_order', 'Display order.'
]);
revoke all on app.setting_choices from public, anon;
grant select on app.setting_choices to authenticated, service_role;

-- Value validation shared by both value tables.
create or replace function private.assert_setting_value(
  p_setting_key text,
  p_value_text text,
  p_value_boolean boolean,
  p_value_integer bigint
)
returns private.setting_definitions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_def private.setting_definitions;
begin
  select * into v_def from private.setting_definitions d where d.setting_key = p_setting_key;
  if v_def.setting_key is null then
    perform private.refuse('setting_unknown', format('%s is not a registered setting.', p_setting_key));
  end if;
  if num_nonnulls(p_value_text, p_value_boolean, p_value_integer) <> 1
     or (v_def.value_type in ('Text', 'Choice') and p_value_text is null)
     or (v_def.value_type = 'Boolean' and p_value_boolean is null)
     or (v_def.value_type = 'Integer' and p_value_integer is null) then
    perform private.refuse('setting_value_type', format('%s takes one %s value.', p_setting_key, v_def.value_type));
  end if;
  if v_def.value_type = 'Choice' and not exists (
    select 1 from private.setting_choices c where c.setting_key = p_setting_key and c.choice = p_value_text) then
    perform private.refuse('setting_choice', format('%s is not a choice of %s.', p_value_text, p_setting_key));
  end if;
  if v_def.value_type = 'Text' and char_length(p_value_text) > coalesce(v_def.max_length, 4000) then
    perform private.refuse('setting_too_long', format('%s takes at most %s characters.', p_setting_key, coalesce(v_def.max_length, 4000)));
  end if;
  if v_def.value_type = 'Integer' and (p_value_integer < v_def.min_integer or p_value_integer > v_def.max_integer) then
    perform private.refuse('setting_out_of_range', format('%s is outside the allowed range of %s.', p_value_integer, p_setting_key));
  end if;
  return v_def;
end;
$$;

comment on function private.assert_setting_value(text, text, boolean, bigint) is 'Returns the definition of a setting after checking a value against it: one value in the column of its type, a listed choice, the length limit and the integer range. Refuses otherwise.';
revoke all on function private.assert_setting_value(text, text, boolean, bigint) from public, anon, authenticated;

-- Shared-scope values -------------------------------------------------------------------------------------------

create table app.setting_values (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  setting_key text not null references private.setting_definitions (setting_key),
  scope_kind app.setting_scope not null,
  scope_id uuid not null,
  value_text text,
  value_boolean boolean,
  value_integer bigint,
  locked boolean not null default false,
  deleted_at timestamptz,
  constraint setting_values_lock_at_org check (not locked or scope_kind = 'Organization'),
  constraint setting_values_org_scope_id check (scope_kind <> 'Organization' or scope_id = org_id)
);

create unique index setting_values_scope_key on app.setting_values (setting_key, scope_kind, scope_id) where deleted_at is null;
create index setting_values_org_key_idx on app.setting_values (org_id, setting_key);

call private.install_domain_table('app.setting_values');
call private.describe('app.setting_values', 'Setting values stored for an org, workspace, team or project (Section 4.5.6). A missing row means the scope inherits. An org value can be locked so no lower scope or person overrides it.', array[
  'setting_key', 'Registered setting.',
  'scope_kind', 'Scope the value is stored at.',
  'scope_id', 'Org, workspace, team or project id the value applies to; the org id for Organization.',
  'value_text', 'Value of a Text or Choice setting.',
  'value_boolean', 'Value of a Boolean setting.',
  'value_integer', 'Value of an Integer setting.',
  'locked', 'True when the org locked this value; only Organization values of lockable settings may be locked.'
]);

create or replace function private.setting_scope_org(p_scope_kind app.setting_scope, p_scope_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_scope_kind
    when 'Organization' then (select o.id from app.organizations o where o.id = p_scope_id)
    when 'Workspace' then (select w.org_id from app.workspaces w where w.id = p_scope_id and w.deleted_at is null)
    when 'Team' then (select t.org_id from app.teams t where t.id = p_scope_id and t.deleted_at is null)
    when 'Project' then (select p.org_id from app.projects p where p.id = p_scope_id and p.deleted_at is null)
  end;
$$;

comment on function private.setting_scope_org(app.setting_scope, uuid) is 'Org that owns a setting scope, or NULL when the scope does not exist.';
revoke all on function private.setting_scope_org(app.setting_scope, uuid) from public, anon, authenticated;

create or replace function private.org_setting_locked(p_org_id uuid, p_setting_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.setting_values v
    where v.org_id = p_org_id and v.setting_key = p_setting_key and v.scope_kind = 'Organization'
      and v.locked and v.deleted_at is null
  );
$$;

comment on function private.org_setting_locked(uuid, text) is 'True when the org has locked its value of the setting. Read by the guards of both value tables, never by the policy of app.setting_values.';
revoke all on function private.org_setting_locked(uuid, text) from public, anon, authenticated;

create or replace function private.can_write_setting(p_org_id uuid, p_setting_key text, p_scope_kind app.setting_scope, p_scope_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.has_capability(p_org_id, d.capability_code,
      case when p_scope_kind = 'Organization' then null else p_scope_id end)
    from private.setting_definitions d where d.setting_key = p_setting_key
  ), false);
$$;

comment on function private.can_write_setting(uuid, text, app.setting_scope, uuid) is 'Policy helper: true when the signed-in person holds the setting''s capability for the scope. Takes column values (ADR 0016 item 14).';
revoke all on function private.can_write_setting(uuid, text, app.setting_scope, uuid) from public, anon;
grant execute on function private.can_write_setting(uuid, text, app.setting_scope, uuid) to authenticated, service_role;

create or replace function private.guard_setting_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_def private.setting_definitions;
begin
  if tg_op = 'UPDATE' and (new.setting_key <> old.setting_key or new.scope_kind <> old.scope_kind or new.scope_id <> old.scope_id) then
    perform private.refuse('setting_scope_immutable', 'A setting value stays with its setting and scope; clear it and set another.');
  end if;
  if private.setting_scope_org(new.scope_kind, new.scope_id) is distinct from new.org_id then
    perform private.refuse('setting_scope_org', 'The scope must belong to the org.');
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  v_def := private.assert_setting_value(new.setting_key, new.value_text, new.value_boolean, new.value_integer);
  if (new.scope_kind = 'Organization' and not v_def.allows_organization)
     or (new.scope_kind = 'Workspace' and not v_def.allows_workspace)
     or (new.scope_kind = 'Team' and not v_def.allows_team)
     or (new.scope_kind = 'Project' and not v_def.allows_project) then
    perform private.refuse('setting_scope_not_allowed', format('%s cannot be set for a %s.', new.setting_key, lower(new.scope_kind::text)));
  end if;
  if new.locked and not v_def.lockable then
    perform private.refuse('setting_not_lockable', format('%s cannot be locked.', new.setting_key));
  end if;
  if new.scope_kind <> 'Organization' and private.org_setting_locked(new.org_id, new.setting_key) then
    perform private.refuse('setting_locked', format('The org locked %s; lower scopes cannot override it.', new.setting_key));
  end if;
  return new;
end;
$$;

comment on function private.guard_setting_value() is 'Setting values: the scope belongs to the org, the value matches the definition, the scope is allowed, only lockable org values lock, and a locked org value refuses lower-scope overrides (Section 4.5.6).';
revoke all on function private.guard_setting_value() from public, anon, authenticated;

create trigger t40_guard_setting_value before insert or update on app.setting_values
  for each row execute function private.guard_setting_value();

call private.install_policies('app.setting_values',
  $$org_id in (select private.my_org_ids())$$,
  $$private.can_write_setting(org_id, setting_key, scope_kind, scope_id)$$);

-- Personal values -------------------------------------------------------------------------------------------------
-- Personal settings belong to the person, across every org and all three shells. org_id names an org only for
-- a value the person keeps for one org (for example the persona that shapes the Atlas sidebar there).

create table app.personal_setting_values (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  org_id uuid references app.organizations (id),
  setting_key text not null references private.setting_definitions (setting_key),
  value_text text,
  value_boolean boolean,
  value_integer bigint,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz
);

create unique index personal_setting_values_key on app.personal_setting_values
  (person_id, setting_key, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) where deleted_at is null;
create index personal_setting_values_org_id_idx on app.personal_setting_values (org_id);
create index personal_setting_values_setting_key_idx on app.personal_setting_values (setting_key);

call private.install_audit_columns('app.personal_setting_values');
call private.describe('app.personal_setting_values', 'A person''s own setting values (Section 4.5.6 Personal settings), shared by Atlas, Gateway and Compass. Readable and writable only by the person. A value for one org overrides the person''s value for every org.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person the value belongs to.',
  'org_id', 'Org the value applies to; NULL for every org.',
  'setting_key', 'Registered setting that allows personal values.',
  'value_text', 'Value of a Text or Choice setting.',
  'value_boolean', 'Value of a Boolean setting.',
  'value_integer', 'Value of an Integer setting.',
  'created_at', 'When the row was created.',
  'created_by', 'Person who created the row.',
  'updated_at', 'When the row last changed.',
  'updated_by', 'Person who last changed the row.',
  'deleted_at', 'When the value was cleared; the scope then inherits.'
]);

create or replace function private.guard_personal_setting_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_def private.setting_definitions;
begin
  if tg_op = 'UPDATE' and (new.person_id <> old.person_id or new.setting_key <> old.setting_key
      or new.org_id is distinct from old.org_id) then
    perform private.refuse('setting_scope_immutable', 'A setting value stays with its setting and scope; clear it and set another.');
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  v_def := private.assert_setting_value(new.setting_key, new.value_text, new.value_boolean, new.value_integer);
  if not v_def.allows_personal then
    perform private.refuse('setting_scope_not_allowed', format('%s cannot be set per person.', new.setting_key));
  end if;
  if new.org_id is not null and not exists (
    select 1 from app.memberships m
    where m.org_id = new.org_id and m.person_id = new.person_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('not_member', 'A per-org value needs an active membership in that org.');
  end if;
  if new.org_id is not null and private.org_setting_locked(new.org_id, new.setting_key) then
    perform private.refuse('setting_locked', format('The org locked %s; it cannot be set per person.', new.setting_key));
  end if;
  return new;
end;
$$;

comment on function private.guard_personal_setting_value() is 'Personal setting values: the value matches the definition, the setting allows personal values, a per-org value needs an active membership and respects the org lock.';
revoke all on function private.guard_personal_setting_value() from public, anon, authenticated;

create trigger t40_guard_personal_setting_value before insert or update on app.personal_setting_values
  for each row execute function private.guard_personal_setting_value();

alter table app.personal_setting_values enable row level security;
revoke all on app.personal_setting_values from public, anon, authenticated;
grant select, insert, update on app.personal_setting_values to authenticated;
grant all on app.personal_setting_values to service_role;

create policy personal_setting_values_read on app.personal_setting_values for select to authenticated
  using (person_id = (select private.current_person_id()));
create policy personal_setting_values_insert on app.personal_setting_values for insert to authenticated
  with check (person_id = (select private.current_person_id()));
create policy personal_setting_values_update on app.personal_setting_values for update to authenticated
  using (person_id = (select private.current_person_id()))
  with check (person_id = (select private.current_person_id()));

-- Setting RPCs ----------------------------------------------------------------------------------------------------
-- Definer functions with explicit capability checks; the guards decide every value.

create or replace function app.set_setting(
  p_org_id uuid,
  p_setting_key text,
  p_scope_kind app.setting_scope,
  p_scope_id uuid,
  p_value_text text default null,
  p_value_boolean boolean default null,
  p_value_integer bigint default null,
  p_locked boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scope uuid := case when p_scope_kind = 'Organization' then p_org_id else p_scope_id end;
  v_id uuid;
begin
  if not private.can_write_setting(p_org_id, p_setting_key, p_scope_kind, v_scope) then
    raise exception using errcode = '42501', message = format('the capability that edits %s is required', p_setting_key);
  end if;
  update app.setting_values v
  set value_text = p_value_text, value_boolean = p_value_boolean, value_integer = p_value_integer, locked = p_locked
  where v.setting_key = p_setting_key and v.scope_kind = p_scope_kind and v.scope_id = v_scope and v.deleted_at is null
  returning v.id into v_id;
  if v_id is null then
    insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text, value_boolean, value_integer, locked)
    values (p_org_id, p_setting_key, p_scope_kind, v_scope, p_value_text, p_value_boolean, p_value_integer, p_locked)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.set_setting(uuid, text, app.setting_scope, uuid, text, boolean, bigint, boolean) is 'Sets a setting for an org, workspace, team or project, optionally locking an org value. Needs the setting''s capability; the guard checks type, scope and lock. Returns the value id.';

create or replace function app.clear_setting(p_org_id uuid, p_setting_key text, p_scope_kind app.setting_scope, p_scope_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scope uuid := case when p_scope_kind = 'Organization' then p_org_id else p_scope_id end;
  v_count integer;
begin
  if not private.can_write_setting(p_org_id, p_setting_key, p_scope_kind, v_scope) then
    raise exception using errcode = '42501', message = format('the capability that edits %s is required', p_setting_key);
  end if;
  update app.setting_values v set deleted_at = now()
  where v.org_id = p_org_id and v.setting_key = p_setting_key and v.scope_kind = p_scope_kind and v.scope_id = v_scope
    and v.deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

comment on function app.clear_setting(uuid, text, app.setting_scope, uuid) is 'Clears a stored value so the scope inherits again. Returns true when a value was cleared.';

create or replace function app.set_personal_setting(
  p_setting_key text,
  p_org_id uuid default null,
  p_value_text text default null,
  p_value_boolean boolean default null,
  p_value_integer bigint default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_id uuid;
begin
  update app.personal_setting_values v
  set value_text = p_value_text, value_boolean = p_value_boolean, value_integer = p_value_integer
  where v.person_id = v_person and v.setting_key = p_setting_key and v.org_id is not distinct from p_org_id
    and v.deleted_at is null
  returning v.id into v_id;
  if v_id is null then
    insert into app.personal_setting_values (person_id, org_id, setting_key, value_text, value_boolean, value_integer)
    values (v_person, p_org_id, p_setting_key, p_value_text, p_value_boolean, p_value_integer)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.set_personal_setting(text, uuid, text, boolean, bigint) is 'Sets one of the signed-in person''s own settings, for every org or for one org. Returns the value id.';

create or replace function app.clear_personal_setting(p_setting_key text, p_org_id uuid default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_count integer;
begin
  update app.personal_setting_values v set deleted_at = now()
  where v.person_id = v_person and v.setting_key = p_setting_key and v.org_id is not distinct from p_org_id
    and v.deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

comment on function app.clear_personal_setting(text, uuid) is 'Clears one of the signed-in person''s own settings so it inherits again. Returns true when a value was cleared.';

create or replace function app.resolve_settings(
  p_org_id uuid,
  p_project_id uuid default null,
  p_team_id uuid default null,
  p_workspace_id uuid default null
)
returns table (
  setting_key text,
  value_type app.setting_value_type,
  value_text text,
  value_boolean boolean,
  value_integer bigint,
  source app.setting_source,
  locked boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with candidate as (
    select v.setting_key, v.value_text, v.value_boolean, v.value_integer,
      case v.scope_kind when 'Project' then 'Project' when 'Team' then 'Team' when 'Workspace' then 'Workspace'
        else 'Organization' end::app.setting_source as source,
      v.locked,
      case when v.locked then 0 else case v.scope_kind when 'Project' then 3 when 'Team' then 4 when 'Workspace' then 5 else 6 end end as rank
    from app.setting_values v
    where v.org_id = p_org_id and v.deleted_at is null
      and p_org_id in (select private.my_org_ids())
      and ((v.scope_kind = 'Organization' and v.scope_id = p_org_id)
        or (v.scope_kind = 'Project' and v.scope_id = p_project_id)
        or (v.scope_kind = 'Team' and v.scope_id = p_team_id)
        or (v.scope_kind = 'Workspace' and v.scope_id = p_workspace_id))
    union all
    select pv.setting_key, pv.value_text, pv.value_boolean, pv.value_integer, 'Personal'::app.setting_source, false,
      case when pv.org_id is null then 2 else 1 end
    from app.personal_setting_values pv
    where pv.person_id = private.current_person_id() and pv.deleted_at is null
      and (pv.org_id is null or pv.org_id = p_org_id)
  ),
  best as (
    select distinct on (c.setting_key) c.*
    from candidate c
    order by c.setting_key, c.rank
  )
  select d.setting_key, d.value_type,
    case when b.setting_key is null then d.default_text else b.value_text end,
    case when b.setting_key is null then d.default_boolean else b.value_boolean end,
    case when b.setting_key is null then d.default_integer else b.value_integer end,
    coalesce(b.source, 'Default'),
    coalesce(b.locked, false)
  from app.setting_definitions d
  left join best b on b.setting_key = d.setting_key
  where p_org_id in (select private.my_org_ids()) or d.allows_personal;
$$;

comment on function app.resolve_settings(uuid, uuid, uuid, uuid) is 'Every registered setting resolved for the signed-in person in an org, optionally inside a project, team and workspace: the most specific value wins (Personal, Project, Team, Workspace, Organization, platform default), except that a locked org value wins over every lower scope. Returns the value and the scope it came from (Section 4.5.6).';

revoke all on function app.set_setting(uuid, text, app.setting_scope, uuid, text, boolean, bigint, boolean) from public, anon;
revoke all on function app.clear_setting(uuid, text, app.setting_scope, uuid) from public, anon;
revoke all on function app.set_personal_setting(text, uuid, text, boolean, bigint) from public, anon;
revoke all on function app.clear_personal_setting(text, uuid) from public, anon;
revoke all on function app.resolve_settings(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.set_setting(uuid, text, app.setting_scope, uuid, text, boolean, bigint, boolean) to authenticated, service_role;
grant execute on function app.clear_setting(uuid, text, app.setting_scope, uuid) to authenticated, service_role;
grant execute on function app.set_personal_setting(text, uuid, text, boolean, bigint) to authenticated, service_role;
grant execute on function app.clear_personal_setting(text, uuid) to authenticated, service_role;
grant execute on function app.resolve_settings(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- Brand ----------------------------------------------------------------------------------------------------------

create table private.brand_fonts (
  font_family text primary key,
  sort_order smallint not null unique,
  constraint brand_fonts_name check (char_length(btrim(font_family)) between 1 and 80)
);

comment on table private.brand_fonts is 'Open-licensed font families a brand may choose (Section 12), each served by the platform.';
comment on column private.brand_fonts.font_family is 'CSS font family name.';
comment on column private.brand_fonts.sort_order is 'Display order.';

alter table private.brand_fonts enable row level security;
revoke all on private.brand_fonts from public, anon, authenticated;
grant select on private.brand_fonts to service_role;

insert into private.brand_fonts (font_family, sort_order) values
  ('Inter', 1), ('IBM Plex Sans', 2), ('Source Sans 3', 3), ('Noto Sans', 4), ('Atkinson Hyperlegible', 5);

create view app.brand_fonts as select f.font_family, f.sort_order from private.brand_fonts f;
call private.describe('app.brand_fonts', 'Font families a brand may choose.', array['font_family', 'CSS font family name.', 'sort_order', 'Display order.']);
revoke all on app.brand_fonts from public, anon;
grant select on app.brand_fonts to authenticated, service_role;

create table app.org_brands (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  display_name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text references private.brand_fonts (font_family),
  radius_scale app.brand_radius_scale not null default 'Default',
  email_sender_name text,
  support_email text,
  legal_entity_name text,
  suppress_powered_by boolean not null default false,
  deleted_at timestamptz,
  constraint org_brands_display_name check (display_name is null or char_length(btrim(display_name)) between 1 and 200),
  constraint org_brands_accent check (accent_hex is null or accent_hex ~ '^#[0-9A-F]{6}$'),
  constraint org_brands_neutral_tint check (neutral_tint_hex is null or neutral_tint_hex ~ '^#[0-9A-F]{6}$'),
  constraint org_brands_paths check (
    (logo_light_path is null or logo_light_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$')
    and (logo_dark_path is null or logo_dark_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$')
    and (favicon_path is null or favicon_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$')
    and (app_icon_path is null or app_icon_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}$')),
  constraint org_brands_sender check (email_sender_name is null or char_length(btrim(email_sender_name)) between 1 and 100),
  constraint org_brands_support_email check (support_email is null or (support_email = lower(support_email) and support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  constraint org_brands_legal_entity check (legal_entity_name is null or char_length(btrim(legal_entity_name)) between 1 and 200)
);

create unique index org_brands_one_per_org on app.org_brands (org_id) where deleted_at is null;
create index org_brands_font_family_idx on app.org_brands (font_family);

call private.install_domain_table('app.org_brands');
call private.describe('app.org_brands', 'An org''s white-label brand (Section 12), applied on Atlas, Gateway, emails, PDFs and Compass. One per org. Every override is token-based; the editor blocks accents that fail WCAG 2.2 AA before saving.', array[
  'display_name', 'Brand name shown instead of the org name; NULL uses the org name.',
  'logo_light_path', 'Logo for light themes: object path in the org-brand bucket, starting with the org id.',
  'logo_dark_path', 'Logo for dark themes: object path in the org-brand bucket.',
  'favicon_path', 'Favicon: object path in the org-brand bucket.',
  'app_icon_path', 'App icon: object path in the org-brand bucket.',
  'accent_hex', 'Accent color as uppercase #RRGGBB, replacing accent-default in every theme; NULL keeps the platform accent.',
  'neutral_tint_hex', 'Optional neutral tint as uppercase #RRGGBB.',
  'font_family', 'Optional font family from the approved list; NULL keeps the platform font.',
  'radius_scale', 'Corner radius scale.',
  'email_sender_name', 'Sender name on emails sent for the org.',
  'support_email', 'Support address shown on branded surfaces.',
  'legal_entity_name', 'Legal entity named on generated documents and emails.',
  'suppress_powered_by', 'True hides "Powered by XOS"; takes effect only while the plan includes white label (Pro and above).'
]);

create or replace function private.guard_org_brand()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.suppress_powered_by and (tg_op = 'INSERT' or not old.suppress_powered_by)
     and not private.org_has_feature(new.org_id, 'white_label') then
    perform private.refuse('plan_feature_required', 'Hiding "Powered by XOS" needs a plan with white label (Pro and above).');
  end if;
  return new;
end;
$$;

comment on function private.guard_org_brand() is 'Brands: turning on suppression of "Powered by XOS" needs the white_label plan feature (Section 12).';
revoke all on function private.guard_org_brand() from public, anon, authenticated;

create trigger t40_guard_org_brand before insert or update on app.org_brands
  for each row execute function private.guard_org_brand();

call private.install_policies('app.org_brands',
  $$org_id in (select private.my_org_ids())$$,
  $$private.has_capability(org_id, 'org.white_label.write')$$);

-- Domains ----------------------------------------------------------------------------------------------------------

create table app.org_domains (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  hostname text not null,
  purpose app.org_domain_purpose not null,
  verification_state app.domain_verification_state not null default 'Pending',
  verification_token text not null default ('xos-verify-' || encode(extensions.gen_random_bytes(16), 'hex')),
  verified_at timestamptz,
  last_checked_at timestamptz,
  auto_join_role_id uuid references app.roles (id),
  deleted_at timestamptz,
  constraint org_domains_hostname check (
    hostname = lower(hostname) and char_length(hostname) <= 253
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  constraint org_domains_verified_pair check ((verification_state = 'Verified') = (verified_at is not null)),
  constraint org_domains_auto_join check (auto_join_role_id is null or purpose = 'Verified Domain')
);

create unique index org_domains_org_hostname_key on app.org_domains (org_id, hostname, purpose) where deleted_at is null;
create unique index org_domains_verified_hostname_key on app.org_domains (hostname, purpose)
  where deleted_at is null and verification_state = 'Verified';
create index org_domains_hostname_idx on app.org_domains (hostname);
create index org_domains_auto_join_role_id_idx on app.org_domains (auto_join_role_id);

call private.install_domain_table('app.org_domains', null, null, array['app.roles', 'auto_join_role_id']);
call private.describe('app.org_domains', 'Domains an org claims (Section 12, Section 4.8.1, Section 4.8.3): custom Atlas and Gateway hosts, email sending domains, and verified domains that earn the verified badge and may allow automatic join with a default role. Verification state is written only by the platform verification service.', array[
  'hostname', 'Lowercase host name, for example gateway.example.com.',
  'purpose', 'What the domain is for.',
  'verification_state', 'DNS verification state; changed only by app.record_domain_verification.',
  'verification_token', 'Value the org publishes in a DNS TXT record to prove control.',
  'verified_at', 'When verification last succeeded; NULL unless Verified.',
  'last_checked_at', 'When the verification service last checked DNS.',
  'auto_join_role_id', 'Role given to a person with a confirmed address at this verified domain who joins automatically; NULL turns automatic join off.'
]);

create or replace function private.guard_org_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service boolean := private.in_trusted_operation('domain_verification');
begin
  if tg_op = 'UPDATE' and (new.hostname <> old.hostname or new.purpose <> old.purpose) then
    perform private.refuse('domain_immutable', 'A domain keeps its host name and purpose; remove it and add another.');
  end if;
  if not v_service then
    if tg_op = 'INSERT' then
      new.verification_state := 'Pending';
      new.verified_at := null;
      new.last_checked_at := null;
    elsif new.verification_state <> old.verification_state or new.verified_at is distinct from old.verified_at
       or new.last_checked_at is distinct from old.last_checked_at or new.verification_token <> old.verification_token then
      perform private.refuse('domain_verification_service', 'Only the verification service records verification.');
    end if;
  end if;
  if tg_op = 'INSERT' and new.purpose in ('Atlas', 'Gateway') and not private.org_has_feature(new.org_id, 'custom_domain') then
    perform private.refuse('plan_feature_required', 'Custom domains need a plan with custom domains (Pro and above).');
  end if;
  if tg_op = 'INSERT' and new.purpose = 'Email Sending' and not private.org_has_feature(new.org_id, 'white_label') then
    perform private.refuse('plan_feature_required', 'Email sending domains need a plan with white label (Pro and above).');
  end if;
  if new.auto_join_role_id is not null and new.deleted_at is null then
    if (select r.band from app.roles r where r.id = new.auto_join_role_id) <= 2 then
      perform private.refuse('auto_join_role_band', 'Automatic join cannot grant Owner or Admin.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_org_domain() is 'Org domains: host and purpose never change, verification fields change only inside the verification service, custom Atlas and Gateway domains need the custom_domain feature, email domains need white_label, and automatic join never grants Owner or Admin.';
revoke all on function private.guard_org_domain() from public, anon, authenticated;

create trigger t40_guard_org_domain before insert or update on app.org_domains
  for each row execute function private.guard_org_domain();

create or replace function private.domain_write_capability(p_purpose app.org_domain_purpose)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_purpose = 'Verified Domain' then 'org.security.write' else 'org.white_label.write' end;
$$;

comment on function private.domain_write_capability(app.org_domain_purpose) is 'Capability that manages a domain of the given purpose: Security for verified domains, White Label for the rest.';
revoke all on function private.domain_write_capability(app.org_domain_purpose) from public, anon;
grant execute on function private.domain_write_capability(app.org_domain_purpose) to authenticated, service_role;

call private.install_policies('app.org_domains',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$private.has_capability(org_id, private.domain_write_capability(purpose))$$);

create or replace function app.record_domain_verification(p_org_domain_id uuid, p_verified boolean)
returns app.domain_verification_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state app.domain_verification_state := case when p_verified then 'Verified' else 'Failed' end;
begin
  perform private.begin_trusted_operation('domain_verification');
  update app.org_domains d
  set verification_state = v_state,
      verified_at = case when p_verified then coalesce(d.verified_at, now()) end,
      last_checked_at = now()
  where d.id = p_org_domain_id and d.deleted_at is null;
  if not found then
    perform private.refuse('domain_unknown', 'The domain does not exist or was removed.');
  end if;
  perform private.end_trusted_operation('domain_verification');
  return v_state;
end;
$$;

comment on function app.record_domain_verification(uuid, boolean) is 'Verification service API (service role only): records the result of a DNS check. A verified host name can be held by one org per purpose at a time.';
revoke all on function app.record_domain_verification(uuid, boolean) from public, anon, authenticated;
grant execute on function app.record_domain_verification(uuid, boolean) to service_role;

-- Modules ----------------------------------------------------------------------------------------------------------

create table app.org_module_states (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  module_code text not null references app.capability_modules (code),
  enabled boolean not null,
  deleted_at timestamptz
);

create unique index org_module_states_key on app.org_module_states (org_id, module_code) where deleted_at is null;
create index org_module_states_module_code_idx on app.org_module_states (module_code);

call private.install_domain_table('app.org_module_states');
call private.describe('app.org_module_states', 'Whether a module is on for an org (Section 4.5.2, Section 4.5.6 item 13). A module without a row is on. A module that is off leaves navigation, search and the command menu; its data stays.', array[
  'module_code', 'Module, one of the switchable sidebar modules.',
  'enabled', 'False turns the module off for the whole org.'
]);

create or replace function private.guard_org_module_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.module_code <> old.module_code then
    perform private.refuse('module_immutable', 'A module switch stays with its module.');
  end if;
  if not exists (
    select 1 from app.capability_modules m
    where m.code = new.module_code and m.code <> 'projects'
      and m.nav_group in ('production', 'operations', 'people', 'commercial', 'knowledge')) then
    perform private.refuse('module_not_switchable', format('%s cannot be turned off.', new.module_code));
  end if;
  return new;
end;
$$;

comment on function private.guard_org_module_state() is 'Module switches: only sidebar modules outside Workspace, Projects, Settings and the footer can be turned off.';
revoke all on function private.guard_org_module_state() from public, anon, authenticated;

create trigger t40_guard_org_module_state before insert or update on app.org_module_states
  for each row execute function private.guard_org_module_state();

call private.install_policies('app.org_module_states',
  $$org_id in (select private.my_org_ids())$$,
  $$private.has_capability(org_id, 'org.modules.write')$$);

create or replace function app.set_module_enabled(p_org_id uuid, p_module_code text, p_enabled boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.modules.write') then
    raise exception using errcode = '42501', message = 'org.modules.write is required';
  end if;
  update app.org_module_states s set enabled = p_enabled
  where s.org_id = p_org_id and s.module_code = p_module_code and s.deleted_at is null
  returning s.id into v_id;
  if v_id is null then
    insert into app.org_module_states (org_id, module_code, enabled) values (p_org_id, p_module_code, p_enabled)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.set_module_enabled(uuid, text, boolean) is 'Turns a module on or off for an org. Needs org.modules.write. Returns the switch id.';
revoke all on function app.set_module_enabled(uuid, text, boolean) from public, anon;
grant execute on function app.set_module_enabled(uuid, text, boolean) to authenticated, service_role;

-- Favorites ----------------------------------------------------------------------------------------------------------

create table app.favorites (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  node_id text not null,
  target_id uuid,
  sort_order integer not null default 0,
  deleted_at timestamptz,
  constraint favorites_node_id check (node_id ~ '^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$' and char_length(node_id) <= 120),
  constraint favorites_sort_order check (sort_order between 0 and 10000)
);

create unique index favorites_key on app.favorites
  (person_id, org_id, node_id, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid)) where deleted_at is null;
create index favorites_person_id_idx on app.favorites (person_id);

call private.install_domain_table('app.favorites');
call private.describe('app.favorites', 'Pages and records a person pinned in an org''s sidebar. Private to the person; at most 50 per person and org.', array[
  'person_id', 'Person who pinned it.',
  'node_id', 'Sitemap node of the page, for example finance.budgets.',
  'target_id', 'Record, project or view the favorite opens on that page; NULL for the page itself.',
  'sort_order', 'Position in the Favorites list, ascending.'
]);

create or replace function private.guard_favorite()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.person_id <> old.person_id or new.node_id <> old.node_id
      or new.target_id is distinct from old.target_id) then
    perform private.refuse('favorite_immutable', 'A favorite keeps what it points to; remove it and pin another.');
  end if;
  if tg_op = 'INSERT' and (
    select count(*) from app.favorites f
    where f.person_id = new.person_id and f.org_id = new.org_id and f.deleted_at is null) >= 50 then
    perform private.refuse('favorites_limit', 'Favorites hold at most 50 items per org; remove one first.');
  end if;
  return new;
end;
$$;

comment on function private.guard_favorite() is 'Favorites: a favorite never changes target, and a person keeps at most 50 per org.';
revoke all on function private.guard_favorite() from public, anon, authenticated;

create trigger t40_guard_favorite before insert or update on app.favorites
  for each row execute function private.guard_favorite();

call private.install_policies('app.favorites',
  $$person_id = (select private.current_person_id())$$,
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$);

-- Brand assets bucket ------------------------------------------------------------------------------------------------
-- Logos and icons are public (they appear on sign-in pages before anyone signs in). Objects live under the org
-- id; only White Label editors of that org write them.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-brand', 'org-brand', true, 2097152, array['image/png', 'image/svg+xml', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'])
on conflict (id) do nothing;

create or replace function private.brand_object_org(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

comment on function private.brand_object_org(text) is 'Org id at the start of an org-brand object path, or NULL when the path does not start with one.';
revoke all on function private.brand_object_org(text) from public, anon;
grant execute on function private.brand_object_org(text) to authenticated, service_role;

create policy org_brand_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'org-brand' and private.has_capability(private.brand_object_org(name), 'org.white_label.write'));
create policy org_brand_update on storage.objects for update to authenticated
  using (bucket_id = 'org-brand' and private.has_capability(private.brand_object_org(name), 'org.white_label.write'))
  with check (bucket_id = 'org-brand' and private.has_capability(private.brand_object_org(name), 'org.white_label.write'));
create policy org_brand_delete on storage.objects for delete to authenticated
  using (bucket_id = 'org-brand' and private.has_capability(private.brand_object_org(name), 'org.white_label.write'));

-- Public brand lookups -------------------------------------------------------------------------------------------------

create or replace function private.public_brand(p_org_id uuid)
returns table (
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.slug,
    coalesce(b.display_name, o.name),
    b.logo_light_path, b.logo_dark_path, b.favicon_path, b.app_icon_path,
    b.accent_hex, b.neutral_tint_hex, b.font_family, coalesce(b.radius_scale, 'Default'),
    coalesce(b.suppress_powered_by, false) and private.org_has_feature(o.id, 'white_label')
  from app.organizations o
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  where o.id = p_org_id and o.deleted_at is null;
$$;

comment on function private.public_brand(uuid) is 'The public half of an org''s brand. "Powered by XOS" stays shown unless the plan includes white label now, so a downgrade reverts it.';
revoke all on function private.public_brand(uuid) from public, anon, authenticated;

create or replace function api_public.org_brand_for_host(p_host text)
returns table (
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean,
  surface app.org_domain_purpose
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.*, d.purpose
  from app.org_domains d
  cross join lateral private.public_brand(d.org_id) b
  where d.hostname = lower(btrim(p_host)) and d.purpose in ('Atlas', 'Gateway')
    and d.verification_state = 'Verified' and d.deleted_at is null
    and private.org_has_feature(d.org_id, 'custom_domain');
$$;

comment on function api_public.org_brand_for_host(text) is 'White label lookup by request host (Section 4.4.7): the brand of the org whose verified custom Atlas or Gateway domain the host is, with the surface it serves. Returns nothing for any other host, and nothing once the plan no longer includes custom domains.';
revoke all on function api_public.org_brand_for_host(text) from public;
grant execute on function api_public.org_brand_for_host(text) to anon, authenticated, service_role;

create or replace function api_public.org_brand_for_slug(p_org_slug text)
returns table (
  org_slug text,
  name text,
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  app_icon_path text,
  accent_hex text,
  neutral_tint_hex text,
  font_family text,
  radius_scale app.brand_radius_scale,
  suppress_powered_by boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.* from app.organizations o cross join lateral private.public_brand(o.id) b
  where o.slug = p_org_slug and o.deleted_at is null;
$$;

comment on function api_public.org_brand_for_slug(text) is 'White label lookup by org slug, for branded invite, sign-in and token pages on the platform domain. Returns only the public brand fields.';
revoke all on function api_public.org_brand_for_slug(text) from public;
grant execute on function api_public.org_brand_for_slug(text) to anon, authenticated, service_role;

-- Domain events, audit trail and retention -----------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('organization.brand_changed', 'org_brands', 'An org''s white-label brand was created or changed.'),
  ('organization.domain_added', 'org_domains', 'An org claimed a domain.'),
  ('organization.domain_verified', 'org_domains', 'An org domain passed DNS verification.'),
  ('organization.module_switched', 'org_module_states', 'An org turned a module on or off.'),
  ('setting.changed', 'setting_values', 'An org, workspace, team or project setting was set, locked or cleared.'),
  ('legal.accepted', 'legal_acceptances', 'A legal document version was accepted on behalf of an org.')
on conflict (code) do nothing;

create or replace function private.emit_settings_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
begin
  if tg_table_name = 'org_brands' then
    perform private.emit_event(new.org_id, 'organization.brand_changed', tg_table_name, new.id, null,
      jsonb_build_object('accent_hex', v_row -> 'accent_hex', 'suppress_powered_by', v_row -> 'suppress_powered_by'));
  elsif tg_table_name = 'org_domains' then
    if tg_op = 'INSERT' then
      perform private.emit_event(new.org_id, 'organization.domain_added', tg_table_name, new.id, null,
        jsonb_build_object('hostname', v_row -> 'hostname', 'purpose', v_row -> 'purpose'));
    elsif v_row ->> 'verification_state' = 'Verified' and (to_jsonb(old) ->> 'verification_state') <> 'Verified' then
      perform private.emit_event(new.org_id, 'organization.domain_verified', tg_table_name, new.id, null,
        jsonb_build_object('hostname', v_row -> 'hostname', 'purpose', v_row -> 'purpose'));
    end if;
  elsif tg_table_name = 'org_module_states' then
    perform private.emit_event(new.org_id, 'organization.module_switched', tg_table_name, new.id, null,
      jsonb_build_object('module_code', v_row -> 'module_code', 'enabled', v_row -> 'enabled'));
  elsif tg_table_name = 'setting_values' then
    perform private.emit_event(new.org_id, 'setting.changed', tg_table_name, new.id, null,
      jsonb_build_object('setting_key', v_row -> 'setting_key', 'scope_kind', v_row -> 'scope_kind',
        'scope_id', v_row -> 'scope_id', 'locked', v_row -> 'locked', 'cleared', (v_row ->> 'deleted_at') is not null));
  elsif tg_table_name = 'legal_acceptances' and new.org_id is not null then
    perform private.emit_event(new.org_id, 'legal.accepted', tg_table_name, new.id, null,
      jsonb_build_object('document_slug', v_row -> 'document_slug', 'document_version', v_row -> 'document_version'));
  end if;
  return null;
end;
$$;

comment on function private.emit_settings_event() is 'After insert or update: emits the settings domain events (brand, domain, module, setting, legal acceptance) with named non-restricted columns only.';
revoke all on function private.emit_settings_event() from public, anon, authenticated;

create trigger t80_emit_event after insert or update on app.org_brands for each row execute function private.emit_settings_event();
create trigger t80_emit_event after insert or update on app.org_domains for each row execute function private.emit_settings_event();
create trigger t80_emit_event after insert or update on app.org_module_states for each row execute function private.emit_settings_event();
create trigger t80_emit_event after insert or update on app.setting_values for each row execute function private.emit_settings_event();
create trigger t80_emit_event after insert on app.legal_acceptances for each row execute function private.emit_settings_event();

call private.install_audit_trail('app.legal_acceptances');
call private.install_audit_trail('app.setting_values');
call private.install_audit_trail('app.org_brands');
call private.install_audit_trail('app.org_domains');
call private.install_audit_trail('app.org_module_states');

call private.install_default_retention('app.legal_acceptances', interval '10 years');
call private.install_default_retention('app.setting_values');
call private.install_default_retention('app.personal_setting_values');
call private.install_default_retention('app.org_brands');
call private.install_default_retention('app.org_domains');
call private.install_default_retention('app.org_module_states');
call private.install_default_retention('app.favorites', interval '1 year');
