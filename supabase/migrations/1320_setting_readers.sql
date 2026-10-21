-- 1320_setting_readers.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1). Typed readers for database code that applies a registered
-- setting (Section 4.5.6). app.resolve_settings answers for the signed-in person and checks their membership;
-- rules inside RPCs and jobs need the value for a given org, workspace, project and person instead, with the
-- same precedence: Personal (a value kept for this org over one for every org), Project, Workspace,
-- Organization, platform default, except that a locked Organization value wins over every lower scope.
--
--   * private.setting_value returns the winning value in its typed columns.
--   * private.setting_boolean, private.setting_text and private.setting_integer return one column.
--   * private.project_setting_boolean and private.project_setting_text read the org and workspace from a project.
--
-- Team values need a team context that RPCs do not have, so the readers skip them. Every reader is SECURITY
-- DEFINER, stable, pins search_path and is executable only by the definer roles that call it.

create or replace function private.setting_value(
  p_org_id uuid,
  p_setting_key text,
  p_workspace_id uuid default null,
  p_project_id uuid default null,
  p_person_id uuid default null
)
returns table (value_text text, value_boolean boolean, value_integer bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with candidate as (
    select v.value_text, v.value_boolean, v.value_integer,
      case when v.locked then 0 else case v.scope_kind when 'Project' then 3 when 'Workspace' then 5 else 6 end end as rank
    from app.setting_values v
    where v.org_id = p_org_id and v.setting_key = p_setting_key and v.deleted_at is null
      and ((v.scope_kind = 'Organization' and v.scope_id = p_org_id)
        or (v.scope_kind = 'Workspace' and v.scope_id = p_workspace_id)
        or (v.scope_kind = 'Project' and v.scope_id = p_project_id))
    union all
    select pv.value_text, pv.value_boolean, pv.value_integer, case when pv.org_id is null then 2 else 1 end
    from app.personal_setting_values pv
    where p_person_id is not null and pv.person_id = p_person_id and pv.setting_key = p_setting_key
      and pv.deleted_at is null and (pv.org_id is null or pv.org_id = p_org_id)
  )
  select case when b.rank is null then d.default_text else b.value_text end,
    case when b.rank is null then d.default_boolean else b.value_boolean end,
    case when b.rank is null then d.default_integer else b.value_integer end
  from private.setting_definitions d
  left join lateral (select c.value_text, c.value_boolean, c.value_integer, c.rank from candidate c order by c.rank limit 1) b on true
  where d.setting_key = p_setting_key;
$$;

comment on function private.setting_value(uuid, text, uuid, uuid, uuid) is 'The value of a registered setting for an org, optionally inside a workspace and project and for a person: Personal (this org over every org), Project, Workspace, Organization, platform default, with a locked Organization value winning over every lower scope (Section 4.5.6). Returns one row in the column of the setting''s type, or no row for an unknown key. For rules inside RPCs and jobs; never checks the caller.';

create or replace function private.setting_boolean(
  p_org_id uuid,
  p_setting_key text,
  p_workspace_id uuid default null,
  p_project_id uuid default null,
  p_person_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select v.value_boolean from private.setting_value(p_org_id, p_setting_key, p_workspace_id, p_project_id, p_person_id) v;
$$;

comment on function private.setting_boolean(uuid, text, uuid, uuid, uuid) is 'A Boolean setting''s value through private.setting_value.';

create or replace function private.setting_text(
  p_org_id uuid,
  p_setting_key text,
  p_workspace_id uuid default null,
  p_project_id uuid default null,
  p_person_id uuid default null
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select v.value_text from private.setting_value(p_org_id, p_setting_key, p_workspace_id, p_project_id, p_person_id) v;
$$;

comment on function private.setting_text(uuid, text, uuid, uuid, uuid) is 'A Text or Choice setting''s value through private.setting_value.';

create or replace function private.setting_integer(
  p_org_id uuid,
  p_setting_key text,
  p_workspace_id uuid default null,
  p_project_id uuid default null,
  p_person_id uuid default null
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select v.value_integer from private.setting_value(p_org_id, p_setting_key, p_workspace_id, p_project_id, p_person_id) v;
$$;

comment on function private.setting_integer(uuid, text, uuid, uuid, uuid) is 'An Integer setting''s value through private.setting_value.';

create or replace function private.project_setting_boolean(p_project_id uuid, p_setting_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.setting_boolean(p.org_id, p_setting_key, p.workspace_id, p.id)
  from app.projects p where p.id = p_project_id;
$$;

comment on function private.project_setting_boolean(uuid, text) is 'A Boolean setting as it applies on a project: the project, its workspace, its org, then the default.';

create or replace function private.project_setting_text(p_project_id uuid, p_setting_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.setting_text(p.org_id, p_setting_key, p.workspace_id, p.id)
  from app.projects p where p.id = p_project_id;
$$;

comment on function private.project_setting_text(uuid, text) is 'A Text or Choice setting as it applies on a project: the project, its workspace, its org, then the default.';

revoke all on function private.setting_value(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.setting_boolean(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.setting_text(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.setting_integer(uuid, text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.project_setting_boolean(uuid, text) from public, anon, authenticated;
revoke all on function private.project_setting_text(uuid, text) from public, anon, authenticated;
grant execute on function private.setting_value(uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function private.setting_boolean(uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function private.setting_text(uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function private.setting_integer(uuid, text, uuid, uuid, uuid) to service_role;
grant execute on function private.project_setting_boolean(uuid, text) to service_role;
grant execute on function private.project_setting_text(uuid, text) to service_role;
