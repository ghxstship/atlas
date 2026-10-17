-- 1062_access_transparency.sql
-- A36 Access transparency (Section 8.4):
--   * View as role: app.view_as_capabilities gives, for a role the viewer previews, each capability at the
--     lesser of the role's reach and the viewer's own, so a preview never shows more than the viewer may
--     already see. Atlas narrows navigation and controls to that set while every read keeps the viewer's
--     own row level security.
--   * Why can I see this: app.explain_access lists the memberships, roles, project memberships, grants,
--     delegations, support sessions and the read policy that give the signed-in person a record. It first
--     reads the record with the person's own row level security, so it explains only what they can see.

-- View as role ------------------------------------------------------------------------------------------------

create or replace function app.view_as_capabilities(p_org_id uuid, p_role_id uuid)
returns table (capability_code text, role_reach app.capability_reach, viewer_reach app.capability_reach, preview_reach app.capability_reach)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_role app.roles;
begin
  if not private.has_capability(p_org_id, 'org.view_as_role.use') then
    raise exception using errcode = '42501', message = 'org.view_as_role.use is required';
  end if;
  select * into v_role from app.roles r where r.id = p_role_id and r.deleted_at is null and (r.org_id is null or r.org_id = p_org_id);
  if v_role.id is null then
    perform private.refuse('view_as_role_unknown', 'Preview a platform role or one of this org''s roles.');
  end if;
  return query
  select rc.capability_code, rc.reach, m.reach,
    case when m.reach is null then null::app.capability_reach else least(rc.reach, m.reach) end
  from app.role_capabilities rc
  cross join lateral (select private.person_capability_reach(v_person, p_org_id, rc.capability_code, true) as reach) m
  where rc.role_id = v_role.id and rc.deleted_at is null
  order by rc.capability_code;
end;
$$;

comment on function app.view_as_capabilities(uuid, uuid) is 'View as role (Section 8.4) for a holder of org.view_as_role.use: every capability of the previewed role with the role''s reach, the viewer''s own reach and the preview reach, the lesser of the two (null when the viewer lacks it). A preview never grants more than the viewer already holds.';
revoke all on function app.view_as_capabilities(uuid, uuid) from public, anon;
grant execute on function app.view_as_capabilities(uuid, uuid) to authenticated, service_role;

-- Why can I see this ---------------------------------------------------------------------------------------------

create or replace function private.access_paths(p_person_id uuid, p_org_id uuid, p_subject_table text, p_subject_id uuid, p_project_id uuid)
returns table (path_kind text, ordinal integer, label text, detail text, valid_to timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  -- Membership and the roles it holds.
  select 'Membership'::text, 1, o.name,
    (select string_agg(coalesce(r.name, r.code), ', ' order by r.band) from app.membership_roles mr
     join app.roles r on r.id = mr.role_id and r.deleted_at is null
     where mr.membership_id = m.id and mr.deleted_at is null),
    m.valid_to
  from app.memberships m join app.organizations o on o.id = m.org_id
  where m.person_id = p_person_id and m.org_id = p_org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  union all
  -- Project membership, when the record belongs to a project.
  select 'Project Membership', 2, p.project_key || ' ' || p.name, pm.project_role::text, pm.valid_to
  from app.project_members pm
  join app.memberships m on m.id = pm.membership_id
  join app.projects p on p.id = pm.project_id
  where p_project_id is not null and pm.project_id = p_project_id and m.person_id = p_person_id
    and pm.deleted_at is null and m.deleted_at is null and (pm.valid_to is null or pm.valid_to > now())
  union all
  -- Capability grants made to the person directly.
  select 'Capability Grant', 3, g.capability_code, coalesce(g.scope_kind::text, 'organization'), g.valid_to
  from app.user_capability_grants g join app.memberships m on m.id = g.membership_id
  where m.person_id = p_person_id and g.org_id = p_org_id and g.deleted_at is null
    and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
    and (g.scope_id is null or g.scope_id in (p_subject_id, p_project_id))
  union all
  -- Record grants to the person or to an org they belong to, on the record, its project or the org;
  -- grants a support session issued are shown once as the session.
  select 'Record Grant', 4, rg.capability_code, rg.target_kind::text || ': ' || rg.reason, rg.valid_to
  from app.record_grants rg
  where rg.org_id = p_org_id and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
    and rg.target_id in (p_subject_id, p_project_id, p_org_id)
    and (rg.grantee_person_id = p_person_id or rg.grantee_org_id in (select private.person_org_ids(p_person_id)))
    and not exists (select 1 from app.support_session_grants sg where sg.record_grant_id = rg.id)
  union all
  select 'Support Session', 5, go.name, s.reason, s.ends_at
  from app.support_sessions s join app.organizations go on go.id = s.grantee_org_id
  where s.org_id = p_org_id and s.ended_at is null and s.ends_at > now() and s.deleted_at is null
    and s.grantee_org_id in (select private.person_org_ids(p_person_id))
  union all
  -- Delegations the person holds from another member.
  select 'Delegation', 6, coalesce(dp.full_name, ''), coalesce(d.capability_code, 'approve'), d.valid_to
  from app.delegations d
  join app.memberships em on em.id = d.delegate_membership_id
  join app.memberships dm on dm.id = d.delegator_membership_id
  join app.people dp on dp.id = dm.person_id
  where d.org_id = p_org_id and em.person_id = p_person_id and d.deleted_at is null
    and d.valid_from <= now() and d.valid_to > now()
  union all
  -- The row level security policy that admitted the read.
  select 'Policy', 7, pol.policyname::text, pol.qual::text, null::timestamptz
  from pg_catalog.pg_policies pol
  where pol.schemaname = 'app' and pol.tablename = p_subject_table and pol.cmd = 'SELECT';
$$;

comment on function private.access_paths(uuid, uuid, text, uuid, uuid) is 'Every path by which a person reaches a record of an org: membership and roles, project membership, direct capability grants, record grants, support sessions, delegations and the table''s read policy. Takes every value as an argument (ADR 0016 rule 14).';
revoke all on function private.access_paths(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;

create or replace function app.my_access_paths(p_org_id uuid, p_subject_table text, p_subject_id uuid, p_project_id uuid)
returns table (path_kind text, ordinal integer, label text, detail text, valid_to timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select * from private.access_paths(private.current_person_id(), p_org_id, p_subject_table, p_subject_id, p_project_id);
$$;

comment on function app.my_access_paths(uuid, text, uuid, uuid) is 'The signed-in person''s own access paths into an org for a record: only facts about their own memberships, grants, sessions and delegations, plus the table''s read policy. app.explain_access calls it after reading the record with the person''s row level security.';
revoke all on function app.my_access_paths(uuid, text, uuid, uuid) from public, anon;
grant execute on function app.my_access_paths(uuid, text, uuid, uuid) to authenticated, service_role;

create or replace function app.explain_access(p_subject_table text, p_subject_id uuid)
returns table (path_kind text, ordinal integer, label text, detail text, valid_to timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_project uuid;
  v_has_project boolean;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if p_subject_table is null or p_subject_table !~ '^[a-z][a-z0-9_]*$' or not exists (
      select 1 from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relname = p_subject_table and c.relkind in ('r', 'p')
        and a.attname = 'org_id' and not a.attisdropped) then
    raise exception using errcode = 'XR001', message = 'explain_table_unknown: Only records of tenant tables are explained.',
      hint = 'explain_table_unknown';
  end if;
  v_has_project := exists (select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relname = p_subject_table and a.attname = 'project_id' and not a.attisdropped);
  -- Read with the caller's own row level security: a record they cannot see is not found.
  if v_has_project then
    execute format('select org_id, project_id from app.%I where id = $1', p_subject_table) into v_org, v_project using p_subject_id;
  else
    execute format('select org_id from app.%I where id = $1', p_subject_table) into v_org using p_subject_id;
  end if;
  if v_org is null then
    raise exception using errcode = '42501', message = 'record not found';
  end if;
  return query select * from app.my_access_paths(v_org, p_subject_table, p_subject_id,
    case when p_subject_table = 'projects' then p_subject_id else v_project end) x
    order by x.ordinal, x.label;
end;
$$;

comment on function app.explain_access(text, uuid) is 'Why can I see this (Section 8.4): reads the record with the caller''s own row level security (not found otherwise), then lists every membership, role, project membership, grant, support session, delegation and read policy that gives the caller access, most direct first.';
revoke all on function app.explain_access(text, uuid) from public, anon;
grant execute on function app.explain_access(text, uuid) to authenticated, service_role;
