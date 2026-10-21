-- 1397_settings_reader_fixes.sql
-- Orchestrator fix (RRR-121, audit of A76 on batch-c): three settings readers agree with the rules the database
-- applies.
--
--   * app.resolve_settings (0850) inside a project reads the project's workspace when the caller passes none. Compass
--     and the Atlas crew pages resolve with a project only, so a Workspace value of time.photo_on_punch,
--     time.geofence_required, time.kiosk_enabled, scheduling.allow_swaps or scheduling.swap_requires_approval was
--     dropped there while private.project_setting_* (1320) applied it, and the kiosk refused every punch it sent.
--   * app.explore_organizations (1132) counts an org's open opportunities as gateway.marketplace_visibility lets them
--     reach (1327): an org that lowers the setting no longer shows Public listings nobody can open.
--   * app.recipient_language gives the language a person is written to in an org: a locked Organization value of
--     locale.language, their own value (this org over every org), the org's value, then en-US. The notification
--     senders (packages/platform recipientProfile) read it, so an org's language and its lock reach email, push
--     and SMS.

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
  with scope as (
    select coalesce(p_workspace_id,
      (select p.workspace_id from app.projects p where p.id = p_project_id and p.org_id = p_org_id)) as workspace_id
  ),
  candidate as (
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
        or (v.scope_kind = 'Workspace' and v.scope_id = (select s.workspace_id from scope s)))
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

comment on function app.resolve_settings(uuid, uuid, uuid, uuid) is 'Every registered setting resolved for the signed-in person in an org, optionally inside a project, team and workspace: the most specific value wins (Personal, Project, Team, Workspace, Organization, platform default), except that a locked org value wins over every lower scope. Inside a project with no workspace given, the project''s own workspace applies, as private.project_setting_* read it (1397). Returns the value and the scope it came from (Section 4.5.6).';

-- Gateway Explore ----------------------------------------------------------------------------------------------------

create or replace function app.explore_organizations(p_query text default null, p_limit integer default 24)
returns table (
  handle text,
  name text,
  about text,
  logo_path text,
  verified boolean,
  verified_domain text,
  open_opportunities integer,
  indexable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.handle, o.name, p.about, p.logo_path, private.organization_verified(p.org_id),
    (select d.hostname from app.org_domains d
     where d.org_id = p.org_id and d.deleted_at is null and d.purpose = 'Verified Domain' and d.verification_state = 'Verified'
     order by d.verified_at limit 1),
    (select count(*)::int from app.opportunities op
     where op.org_id = p.org_id and op.deleted_at is null and op.opportunity_state = 'Published'
       and private.marketplace_visibility_cap(op.org_id, op.visibility) = 'Public'),
    p.search_indexing
  from app.organization_profiles p
  join app.organizations o on o.id = p.org_id and o.deleted_at is null
  where p.deleted_at is null and p.visibility = 'Public' and private.current_person_id() is not null
    and (nullif(btrim(p_query), '') is null
         or o.name ilike '%' || btrim(p_query) || '%' or coalesce(p.about, '') ilike '%' || btrim(p_query) || '%')
  order by o.name
  limit least(greatest(coalesce(p_limit, 24), 1), 100);
$$;

comment on function app.explore_organizations(text, integer) is 'Public organization profiles for Gateway Explore (journey 62), signed-in only: name, about, logo, the verified badge, the verified domain and how many opportunities are open to everyone, counting a Public listing only while the org''s gateway.marketplace_visibility still allows Public (1327, 1397). indexable is the profile''s own search_indexing, off unless the org turns it on.';

-- The language a person is written to ---------------------------------------------------------------------------------

create or replace function app.recipient_language(p_org_id uuid, p_person_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.setting_text(p_org_id, 'locale.language', null, null, p_person_id), 'en-US');
$$;

comment on function app.recipient_language(uuid, uuid) is 'The language an org writes to a person in (email, push and SMS): a locked Organization value of locale.language, the person''s own value (for this org over every org), the org''s value, then en-US (1397). For the notification senders, which run as the service role.';
revoke all on function app.recipient_language(uuid, uuid) from public, anon, authenticated;
grant execute on function app.recipient_language(uuid, uuid) to service_role;
