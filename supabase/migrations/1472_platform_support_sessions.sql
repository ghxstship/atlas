-- 1472_platform_support_sessions.sql
-- A90 operator console (RRR-135, finding A65-009; Section 8 "Platform operator access", Section 4.1, Section 11.16).
-- A support session (1060) admitted only the client org's partner. The platform team now gets the same consented
-- path: the tenant's Owner grants the platform a session of 1 to 24 hours with a reason, and the org sees who on
-- the platform team opened what.
--   * app.support_sessions gains a grantee (Partner or Platform); a Platform session names no grantee org and
--     issues no record grants, so no Atlas policy opens to it.
--   * app.grant_platform_support_session: the Owner (org.support_session.grant) grants it, one open platform
--     session at a time; app.grant_support_session (latest: 1060) now counts only partner sessions as the open
--     one, so a partner and a platform session can run side by side.
--   * app.end_support_session (latest: 1060): the Owner ends either kind early, partner staff a partner session,
--     an operator with support.sessions a platform session.
--   * app.console_support_view: while a platform session is open, an operator reads the tenant's overview,
--     members, projects or org settings, read-only. Each read writes app.support_session_accesses, whose audit
--     trail lands in the tenant's audit ledger with the operator as the actor, and the console ledger (1470).
--   * app.support_session_access_log: the Owner and audit readers see each access: when, which operator, which area.
--   * Platform sessions and their accesses stay writable while an org is canceled and read-only (Section 14.7), so
--     support can help with the export.

-- Grantee kinds ------------------------------------------------------------------------------------------------------

create type app.support_session_grantee as enum ('Partner', 'Platform');
comment on type app.support_session_grantee is 'Who a support session lets in (A90): the client org''s partner (1060) or the platform team through the operator console.';

alter table app.support_sessions
  add column grantee app.support_session_grantee not null default 'Partner',
  alter column grantee_org_id drop not null,
  add constraint support_sessions_grantee check ((grantee = 'Partner') = (grantee_org_id is not null));

create index support_sessions_open_platform_idx on app.support_sessions (org_id, ends_at)
  where grantee = 'Platform' and ended_at is null and deleted_at is null;

call private.describe('app.support_sessions', 'A support session (Section 4.6.1, Section 8): the org''s Owner lets its partner''s staff (1060) or the platform team (A90) read the org for at most 24 hours. Neither reads anything of the org without one. Created and ended only through the RPCs; every grant, every platform read and every end lands in the org''s audit ledger.', array[
  'grantee', 'Partner or Platform.',
  'grantee_org_id', 'Partner org whose staff may read while a Partner session lasts; null for a Platform session.'
]);

-- Grants and ends (latest definitions: 1060) ------------------------------------------------------------------------

create or replace function app.grant_support_session(p_org_id uuid, p_hours integer, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_partner uuid;
  v_session app.support_sessions;
  v_capability text;
  v_grant uuid;
begin
  if not private.has_capability(p_org_id, 'org.support_session.grant') then
    raise exception using errcode = '42501', message = 'org.support_session.grant is required';
  end if;
  select o.parent_org_id into v_partner from app.organizations o where o.id = p_org_id and o.deleted_at is null;
  if v_partner is null then
    perform private.refuse('support_session_no_partner', 'Only a client org grants its partner a support session.');
  end if;
  if p_hours is null or p_hours not between 1 and 24 then
    perform private.refuse('support_session_hours', 'A support session lasts from 1 to 24 hours.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('support_session_reason', 'Say why the partner needs access, in up to 500 characters.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if exists (select 1 from app.support_sessions s where s.org_id = p_org_id and s.grantee = 'Partner'
             and s.ended_at is null and s.ends_at > now() and s.deleted_at is null) then
    perform private.refuse('support_session_active', 'A support session is already open; end it before granting another.');
  end if;

  insert into app.support_sessions (org_id, grantee, grantee_org_id, reason, ends_at)
  values (p_org_id, 'Partner', v_partner, btrim(p_reason), now() + make_interval(hours => p_hours))
  returning * into v_session;

  for v_capability in select private.support_read_capabilities() loop
    insert into app.record_grants (target_kind, target_id, capability_code, grantee_org_id, valid_from, valid_to, reason)
    values ('organization', p_org_id, v_capability, v_partner, v_session.starts_at, v_session.ends_at,
            left('Support session: ' || btrim(p_reason), 500))
    returning id into v_grant;
    insert into app.support_session_grants (support_session_id, record_grant_id) values (v_session.id, v_grant);
  end loop;
  return v_session.id;
end;
$$;

comment on function app.grant_support_session(uuid, integer, text) is 'The client Owner (org.support_session.grant) lets its partner''s staff read the client org for 1 to 24 hours with a reason: one org-level record grant per read capability, each written to the client''s audit ledger. One open partner session at a time; a platform session (A90) does not count. Returns the session id.';

create or replace function app.grant_platform_support_session(p_org_id uuid, p_hours integer, p_reason text)
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
  if not private.has_capability(p_org_id, 'org.support_session.grant') then
    raise exception using errcode = '42501', message = 'org.support_session.grant is required';
  end if;
  if p_hours is null or p_hours not between 1 and 24 then
    perform private.refuse('support_session_hours', 'A support session lasts from 1 to 24 hours.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('support_session_reason', 'Say why the platform team needs access, in up to 500 characters.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if exists (select 1 from app.support_sessions s where s.org_id = p_org_id and s.grantee = 'Platform'
             and s.ended_at is null and s.ends_at > now() and s.deleted_at is null) then
    perform private.refuse('support_session_active', 'A platform support session is already open; end it before granting another.');
  end if;
  insert into app.support_sessions (org_id, grantee, grantee_org_id, reason, ends_at)
  values (p_org_id, 'Platform', null, btrim(p_reason), now() + make_interval(hours => p_hours))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.grant_platform_support_session(uuid, integer, text) is 'The Owner (org.support_session.grant) lets the platform team read the org through the operator console for 1 to 24 hours with a reason (A90, Section 8). One open platform session at a time. It issues no record grants: operators read only through app.console_support_view, and every read is logged for the org. Returns the session id.';
revoke all on function app.grant_platform_support_session(uuid, integer, text) from public, anon;
grant execute on function app.grant_platform_support_session(uuid, integer, text) to authenticated;

create or replace function app.end_support_session(p_support_session_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_session app.support_sessions;
  v_allowed boolean := false;
  v_operator boolean := false;
begin
  select * into v_session from app.support_sessions s where s.id = p_support_session_id and s.deleted_at is null for update;
  if v_session.id is not null then
    if private.has_capability(v_session.org_id, 'org.support_session.grant') then
      v_allowed := true;
    elsif v_session.grantee = 'Partner' then
      v_allowed := private.has_capability(v_session.grantee_org_id, 'org.partner.manage');
    elsif private.is_platform_staff() then
      perform private.require_platform_operator('support.sessions');
      v_allowed := true;
      v_operator := true;
    end if;
  end if;
  if not v_allowed then
    raise exception using errcode = '42501', message = 'support session not found';
  end if;
  if v_session.ended_at is not null or v_session.ends_at <= now() then
    perform private.refuse('support_session_ended', 'This support session has already ended.');
  end if;
  update app.record_grants g set valid_to = greatest(now(), g.valid_from)
  where g.id in (select sg.record_grant_id from app.support_session_grants sg where sg.support_session_id = v_session.id);
  update app.support_sessions set ended_at = now(), ended_by = v_person where id = v_session.id;
  if v_operator then
    perform private.log_operator_action('support_session.ended', v_session.org_id, 'app.support_sessions', v_session.id,
      null, '{}'::jsonb);
  end if;
  return v_session.id;
end;
$$;

comment on function app.end_support_session(uuid) is 'Ends a support session early: the org''s Owner either kind, the partner''s staff with org.partner.manage a partner session, an operator with support.sessions a platform session (A90). Every grant of the session ends at once.';

create or replace function private.guard_support_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.grantee <> old.grantee
      or new.grantee_org_id is distinct from old.grantee_org_id
      or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.reason <> old.reason
      or (old.ended_at is not null and new.ended_at is distinct from old.ended_at)) then
    perform private.refuse('support_session_immutable', 'A support session keeps its parties, window and reason; it can only be ended early, once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_support_session() is 'Support sessions keep their grantee, parties, window and reason; ending early happens once.';

-- Platform reads -----------------------------------------------------------------------------------------------------

create type app.support_access_area as enum ('Overview', 'Members', 'Projects', 'Settings');
comment on type app.support_access_area is 'What an operator opened during a platform support session (A90).';

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.support_session_accesses', 'Platform support reads during the read-only window are logged for the org.');

create table app.support_session_accesses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  support_session_id uuid not null references app.support_sessions (id),
  operator_person_id uuid not null references app.people (id),
  area app.support_access_area not null,
  accessed_at timestamptz not null default now()
);

create index support_session_accesses_session_idx on app.support_session_accesses (support_session_id, accessed_at);
create index support_session_accesses_operator_idx on app.support_session_accesses (operator_person_id);

call private.install_domain_table('app.support_session_accesses', 'app.support_sessions', 'support_session_id', '{}', true);
call private.describe('app.support_session_accesses', 'Each read an operator made during a platform support session (A90, Section 8): which session, which operator, which area and when. Written only by app.console_support_view; append-only; the audit trail copies each row into the org''s audit ledger.', array[
  'support_session_id', 'Platform support session the read happened in.',
  'operator_person_id', 'Operator who read, from the session.',
  'area', 'Overview, Members, Projects or Settings.',
  'accessed_at', 'When the operator read it, set by the database.'
]);

call private.install_policies('app.support_session_accesses',
  $$org_id in (select private.orgs_with_capability('org.support_session.grant'))
    or org_id in (select private.orgs_with_capability('audit.log.read'))$$);
call private.install_audit_trail('app.support_session_accesses');
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.support_session_accesses', 'Age', 'accessed_at', interval '7 years', 'Delete', 'Access to tenant data is a compliance record (Section 8), kept like its session.');

create or replace function app.console_support_sessions()
returns table (
  id uuid,
  org_id uuid,
  org_name text,
  org_slug text,
  reason text,
  granted_by_name text,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('support.sessions');
  return query
  select s.id, s.org_id, o.name, o.slug, s.reason, p.full_name, s.starts_at, s.ends_at
  from app.support_sessions s
  join app.organizations o on o.id = s.org_id
  left join app.people p on p.id = s.created_by
  where s.grantee = 'Platform' and s.ended_at is null and s.ends_at > now() and s.starts_at <= now()
    and s.deleted_at is null
  order by s.ends_at;
end;
$$;

comment on function app.console_support_sessions() is 'Every open platform support session, soonest to end first (support.sessions): the org, the Owner''s reason, who granted it and its window.';
revoke all on function app.console_support_sessions() from public, anon;
grant execute on function app.console_support_sessions() to authenticated;

create or replace function app.console_support_view(p_support_session_id uuid, p_area app.support_access_area)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('support.sessions');
  v_session app.support_sessions;
  v_org app.organizations;
  v_data jsonb;
begin
  select * into v_session from app.support_sessions s
  where s.id = p_support_session_id and s.grantee = 'Platform' and s.deleted_at is null;
  if v_session.id is null then
    raise exception using errcode = '42501', message = 'support session not found';
  end if;
  if v_session.ended_at is not null or v_session.ends_at <= now() or v_session.starts_at > now() then
    perform private.refuse('support_session_closed', 'This support session has ended. The Owner can grant a new one.');
  end if;
  if p_area is null then
    perform private.refuse('support_access_area', 'Choose what to open.');
  end if;
  select * into v_org from app.organizations o where o.id = v_session.org_id;

  insert into app.support_session_accesses (support_session_id, operator_person_id, area)
  values (v_session.id, v_operator, p_area);
  perform private.log_operator_action('support_session.viewed', v_session.org_id, 'app.support_sessions', v_session.id,
    null, jsonb_build_object('area', p_area));

  if p_area = 'Overview' then
    v_data := jsonb_build_object(
      'members', (select count(distinct m.id) from app.memberships m where m.org_id = v_org.id and m.deleted_at is null
                    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())),
      'projects', (select count(*) from app.projects p where p.org_id = v_org.id and p.deleted_at is null),
      'active_projects', (select count(*) from app.projects p where p.org_id = v_org.id and p.deleted_at is null
                            and p.archived_at is null and p.project_state in ('Proposed', 'Active', 'Blocked')),
      'workspaces', (select count(*) from app.workspaces w where w.org_id = v_org.id and w.deleted_at is null),
      'settings', (select count(*) from app.setting_values v where v.org_id = v_org.id and v.deleted_at is null),
      'open_tickets', (select count(*) from app.support_tickets t where t.org_id = v_org.id and t.queue = 'Platform'
                         and t.ticket_state in ('Open', 'Waiting') and t.deleted_at is null));
  elsif p_area = 'Members' then
    v_data := coalesce((select jsonb_agg(jsonb_build_object('name', x.full_name, 'email', x.email, 'roles', x.roles,
                          'joined', x.valid_from, 'ends', x.valid_to) order by x.full_name nulls last, x.email)
                        from (select m.id, p.full_name, u.email::text as email, m.valid_from, m.valid_to,
                                coalesce(jsonb_agg(r.code order by r.band) filter (where r.id is not null), '[]'::jsonb) as roles
                              from app.memberships m
                              join app.people p on p.id = m.person_id
                              left join auth.users u on u.id = p.user_id
                              left join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
                              left join app.roles r on r.id = mr.role_id and r.deleted_at is null
                              where m.org_id = v_org.id and m.deleted_at is null
                                and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
                              group by m.id, p.full_name, u.email, m.valid_from, m.valid_to
                              limit 500) x), '[]'::jsonb);
  elsif p_area = 'Projects' then
    v_data := coalesce((select jsonb_agg(jsonb_build_object('key', p.project_key, 'name', p.name,
                          'state', p.project_state, 'phase', p.current_phase_code, 'starts_on', p.starts_on,
                          'ends_on', p.ends_on, 'time_zone', p.time_zone, 'archived', p.archived_at is not null)
                          order by p.project_key)
                        from (select * from app.projects y where y.org_id = v_org.id and y.deleted_at is null
                              order by y.project_key limit 500) p), '[]'::jsonb);
  else
    v_data := coalesce((select jsonb_agg(jsonb_build_object('key', v.setting_key,
                          'value', coalesce(v.value_text, v.value_boolean::text, v.value_integer::text),
                          'locked', v.locked) order by v.setting_key)
                        from app.setting_values v
                        where v.org_id = v_org.id and v.scope_kind = 'Organization' and v.deleted_at is null), '[]'::jsonb);
  end if;

  return jsonb_build_object('org', jsonb_build_object('id', v_org.id, 'name', v_org.name, 'slug', v_org.slug),
    'session', jsonb_build_object('id', v_session.id, 'reason', v_session.reason, 'starts_at', v_session.starts_at,
      'ends_at', v_session.ends_at),
    'area', p_area, 'data', v_data);
end;
$$;

comment on function app.console_support_view(uuid, app.support_access_area) is 'While a platform support session is open (A90, Section 8), an operator with support.sessions reads one area of the org, read-only: Overview (counts), Members (names, emails, roles), Projects or Settings (org-level values). Each read is written to app.support_session_accesses, the org''s audit ledger and the console ledger. Refuses support_session_closed after the session ends.';
revoke all on function app.console_support_view(uuid, app.support_access_area) from public, anon;
grant execute on function app.console_support_view(uuid, app.support_access_area) to authenticated;

create or replace function app.support_session_access_log(p_org_id uuid)
returns table (
  id uuid,
  support_session_id uuid,
  operator_name text,
  area app.support_access_area,
  accessed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.has_capability(p_org_id, 'org.support_session.grant') or private.has_capability(p_org_id, 'audit.log.read')) then
    raise exception using errcode = '42501', message = 'org.support_session.grant or audit.log.read is required';
  end if;
  return query
  select a.id, a.support_session_id, p.full_name, a.area, a.accessed_at
  from app.support_session_accesses a
  left join app.people p on p.id = a.operator_person_id
  where a.org_id = p_org_id
  order by a.accessed_at desc, a.id desc
  limit 200;
end;
$$;

comment on function app.support_session_access_log(uuid) is 'Who on the platform team opened what during the org''s platform support sessions (A90, Section 8), newest first: the Owner (org.support_session.grant) and audit readers (audit.log.read). Names the operator, which a member could not otherwise read.';
revoke all on function app.support_session_access_log(uuid) from public, anon;
grant execute on function app.support_session_access_log(uuid) to authenticated;
