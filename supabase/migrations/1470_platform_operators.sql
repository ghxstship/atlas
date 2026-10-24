-- 1470_platform_operators.sql
-- A90 operator console (RRR-135, finding A65-009; Section 4.1 Platform Operator, Section 4.10, Section 6, Section 8).
-- Until now "the platform" was only the service role or a session without a signed-in person
-- (private.is_platform_operator, 0643), so nothing could say which member of the platform team did what. The
-- console runs every action as the operator's own signed-in session instead:
--   * app.platform_operators: the platform team, one live row per person with an operator role (Support, Trust and
--     Safety or Administrator), who granted it and why; revoked once, never edited or deleted. Operators are never
--     org members through this table and reach no tenant row through it.
--   * private.platform_operator_permissions: the console permissions each role holds.
--   * private.require_platform_operator(permission): the one check every console RPC makes first. It refuses
--     anyone who is not a live operator holding the permission, an API key session, and (A77, 1333) a session
--     that has not passed a second factor.
--   * app.platform_operator_actions: an append-only ledger of console actions with the operator's identity. An
--     action on a tenant row also lands in that tenant's audit ledger through the row's audit trail, or through
--     private.write_audit_event for reads (support sessions, 1472).
--   * app.console_whoami and the roster RPCs; private.grant_platform_operator lets the platform (service role or
--     the SQL editor) name the first Administrator, after which Administrators manage the roster in the console.

create type app.platform_operator_role as enum ('Support', 'Trust and Safety', 'Administrator');
comment on type app.platform_operator_role is 'Operator console roles (A90): Support (tenants, support sessions, flags, banners), Trust and Safety (tenants, moderation) and Administrator (everything, including plans and the operator roster).';

-- The platform team ------------------------------------------------------------------------------------------------

create table app.platform_operators (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  operator_role app.platform_operator_role not null,
  reason text not null,
  granted_by uuid references app.people (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  revoke_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint platform_operators_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint platform_operators_not_self check (granted_by is distinct from person_id),
  constraint platform_operators_revoked check ((revoked_at is null) = (revoke_reason is null)
    and (revoked_by is null or revoked_at is not null)),
  constraint platform_operators_revoke_reason_length check (
    revoke_reason is null or char_length(btrim(revoke_reason)) between 1 and 500)
);

create unique index platform_operators_one_live on app.platform_operators (person_id)
  where revoked_at is null and deleted_at is null;
create index platform_operators_granted_by_idx on app.platform_operators (granted_by);
create index platform_operators_revoked_by_idx on app.platform_operators (revoked_by);

call private.install_audit_columns('app.platform_operators');
call private.describe('app.platform_operators', 'The platform team (A90, Section 4.1 Platform Operator): one live row per person who may sign in to the operator console, with the role that sets what they may do there. Written only by the roster RPCs and private.grant_platform_operator; a row is revoked once and never edited or deleted. An operator reaches tenant data only through a support session the tenant Owner grants (1472).', array[
  'id', 'Operator grant id.',
  'person_id', 'Person on the platform team.',
  'operator_role', 'Support, Trust and Safety or Administrator.',
  'reason', 'Why the person joined the platform team, in the granter''s words.',
  'granted_by', 'Administrator who granted the role; null when the platform named the first Administrator.',
  'granted_at', 'When the role was granted.',
  'revoked_at', 'When the role was revoked; the person can no longer sign in to the console.',
  'revoked_by', 'Administrator who revoked it; null when the platform did.',
  'revoke_reason', 'Why the role was revoked.'
]);

alter table app.platform_operators enable row level security;
revoke all on app.platform_operators from public, anon, authenticated;
grant select on app.platform_operators to authenticated;
grant all on app.platform_operators to service_role;

-- Console permissions ----------------------------------------------------------------------------------------------

create table private.platform_operator_permissions (
  operator_role app.platform_operator_role not null,
  permission text not null,
  primary key (operator_role, permission),
  constraint platform_operator_permissions_format check (permission ~ '^[a-z]+\.[a-z_]+$')
);

comment on table private.platform_operator_permissions is 'Which console permissions each operator role holds (A90). private.require_platform_operator checks them in every console RPC.';
comment on column private.platform_operator_permissions.operator_role is 'Operator role.';
comment on column private.platform_operator_permissions.permission is 'Console permission: tenants.read, support.sessions, flags.write, flags.kill_switch, plans.write, moderation.decide, banners.write or operators.manage.';

alter table private.platform_operator_permissions enable row level security;
revoke all on private.platform_operator_permissions from public, anon, authenticated;
grant select on private.platform_operator_permissions to service_role;

insert into private.platform_operator_permissions (operator_role, permission) values
  ('Support', 'tenants.read'),
  ('Support', 'support.sessions'),
  ('Support', 'flags.write'),
  ('Support', 'banners.write'),
  ('Trust and Safety', 'tenants.read'),
  ('Trust and Safety', 'moderation.decide'),
  ('Administrator', 'tenants.read'),
  ('Administrator', 'support.sessions'),
  ('Administrator', 'flags.write'),
  ('Administrator', 'flags.kill_switch'),
  ('Administrator', 'plans.write'),
  ('Administrator', 'moderation.decide'),
  ('Administrator', 'banners.write'),
  ('Administrator', 'operators.manage');

-- The one check ----------------------------------------------------------------------------------------------------

create or replace function private.current_platform_operator()
returns app.platform_operators
language sql
stable
security definer
set search_path = ''
as $$
  select o.* from app.platform_operators o
  where o.person_id = private.current_person_id() and o.revoked_at is null and o.deleted_at is null
    and private.api_key_scopes() is null;
$$;

comment on function private.current_platform_operator() is 'The signed-in person''s live operator grant, or a row of nulls. An API key session is never an operator.';
revoke all on function private.current_platform_operator() from public, anon, authenticated;

create or replace function private.is_platform_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (private.current_platform_operator()).id is not null;
$$;

comment on function private.is_platform_staff() is 'True when the signed-in person holds a live operator grant (A90). Unlike private.is_platform_operator (0643), it names a person, never the service role.';
revoke all on function private.is_platform_staff() from public, anon;
grant execute on function private.is_platform_staff() to authenticated, service_role;

create or replace function private.require_platform_operator(p_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_operator app.platform_operators := private.current_platform_operator();
begin
  if not exists (select 1 from private.platform_operator_permissions p where p.permission = p_permission) then
    raise exception using errcode = '22023', message = format('unknown console permission %s', p_permission);
  end if;
  if v_operator.id is null or not exists (
    select 1 from private.platform_operator_permissions p
    where p.operator_role = v_operator.operator_role and p.permission = p_permission) then
    raise exception using errcode = '42501', message = 'the operator console is for the platform team';
  end if;
  -- Section 9 step-up (A77, 1333): every console action runs in a session that passed a second factor.
  perform private.require_second_factor('use the operator console', false);
  return v_operator.person_id;
end;
$$;

comment on function private.require_platform_operator(text) is 'The check every console RPC makes first (A90): the signed-in person holds a live operator grant whose role has the permission, in a session that passed a second factor (private.require_second_factor, A77). Refuses 42501 otherwise and step_up_required without the second factor. Returns the operator''s person id.';
revoke all on function private.require_platform_operator(text) from public, anon, authenticated;

-- The console ledger -----------------------------------------------------------------------------------------------

create table app.platform_operator_actions (
  id uuid primary key default private.uuid_v7(),
  operator_person_id uuid not null references app.people (id),
  action text not null,
  target_org_id uuid references app.organizations (id),
  subject_table text,
  subject_id uuid,
  reason text,
  details jsonb not null default '{}'::jsonb,
  acted_at timestamptz not null default now(),
  constraint platform_operator_actions_action_format check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint platform_operator_actions_details_object check (jsonb_typeof(details) = 'object'),
  constraint platform_operator_actions_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 4000),
  constraint platform_operator_actions_subject check ((subject_table is null) = (subject_id is null))
);

create index platform_operator_actions_operator_idx on app.platform_operator_actions (operator_person_id, acted_at);
create index platform_operator_actions_target_org_idx on app.platform_operator_actions (target_org_id, acted_at);

call private.describe('app.platform_operator_actions', 'Append-only ledger of operator console actions (A90): who on the platform team did what, to which tenant and row, and why. Written only by the console RPCs. A change to a tenant row also lands in the tenant''s own audit ledger.', array[
  'id', 'Action id, UUID v7.',
  'operator_person_id', 'Operator who acted, from the session.',
  'action', 'What was done, as subject.verb, for example flag_override.set.',
  'target_org_id', 'Tenant the action touched, when it touched one.',
  'subject_table', 'Table of the row acted on, when there is one.',
  'subject_id', 'Row acted on.',
  'reason', 'The operator''s reason or statement, when the action takes one.',
  'details', 'What changed, as display values.',
  'acted_at', 'When the action happened, set by the database.'
]);

alter table app.platform_operator_actions enable row level security;
revoke all on app.platform_operator_actions from public, anon, authenticated;
grant select on app.platform_operator_actions to authenticated;
grant all on app.platform_operator_actions to service_role;

create policy platform_operator_actions_read on app.platform_operator_actions for select to authenticated
  using ((select private.is_platform_staff()));
create policy platform_operators_read on app.platform_operators for select to authenticated
  using ((select private.is_platform_staff()) or person_id = (select private.current_person_id()));

create trigger t95_append_only before update or delete on app.platform_operator_actions
  for each row execute function private.refuse_ledger_change();

create or replace function private.log_operator_action(
  p_action text,
  p_target_org_id uuid default null,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_reason text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app.platform_operator_actions (operator_person_id, action, target_org_id, subject_table, subject_id, reason, details)
  values (private.require_person(), p_action, p_target_org_id, p_subject_table, p_subject_id, nullif(btrim(p_reason), ''),
    coalesce(p_details, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.log_operator_action(text, uuid, text, uuid, text, jsonb) is 'Writes one console action to app.platform_operator_actions as the signed-in operator. Console RPCs call it after private.require_platform_operator.';
revoke all on function private.log_operator_action(text, uuid, text, uuid, text, jsonb) from public, anon, authenticated;

create or replace function private.guard_platform_operator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if private.in_trusted_operation('retention_purge') then
      return old;
    end if;
    perform private.refuse('platform_operator_immutable', 'An operator grant is revoked, never deleted.');
  end if;
  if new.person_id <> old.person_id or new.operator_role <> old.operator_role or new.reason <> old.reason
     or new.granted_by is distinct from old.granted_by or new.granted_at <> old.granted_at
     or (old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at
         or new.revoked_by is distinct from old.revoked_by or new.revoke_reason is distinct from old.revoke_reason)) then
    perform private.refuse('platform_operator_immutable', 'An operator grant keeps its person, role and reason; it can only be revoked, once.');
  end if;
  return new;
end;
$$;

comment on function private.guard_platform_operator() is 'Operator grants keep their person, role, reason and granter, are revoked once and are deleted only by the retention purge, 7 years after revocation.';
revoke all on function private.guard_platform_operator() from public, anon, authenticated;

create trigger t40_guard_platform_operator before update or delete on app.platform_operators
  for each row execute function private.guard_platform_operator();

-- Who is signed in ---------------------------------------------------------------------------------------------------

create or replace function app.console_whoami()
returns table (
  person_id uuid,
  full_name text,
  email text,
  operator_role app.platform_operator_role,
  permissions text[],
  second_factor boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.person_id, p.full_name, u.email::text, o.operator_role,
    array(select x.permission from private.platform_operator_permissions x where x.operator_role = o.operator_role
          order by x.permission),
    private.session_aal() = 'aal2'
  from (select (private.current_platform_operator()).*) o
  join app.people p on p.id = o.person_id
  left join auth.users u on u.id = p.user_id
  where o.id is not null;
$$;

comment on function app.console_whoami() is 'The signed-in operator (A90): name, email, role, the console permissions it holds and whether the session passed a second factor. No row for anyone who is not a live operator, so the console signs them out.';
revoke all on function app.console_whoami() from public, anon;
grant execute on function app.console_whoami() to authenticated;

-- The roster -------------------------------------------------------------------------------------------------------

create or replace function app.console_operators()
returns table (
  id uuid,
  person_id uuid,
  full_name text,
  email text,
  operator_role app.platform_operator_role,
  reason text,
  granted_by_name text,
  granted_at timestamptz,
  revoked_at timestamptz,
  revoked_by_name text,
  revoke_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('operators.manage');
  return query
  select o.id, o.person_id, p.full_name, u.email::text, o.operator_role, o.reason, g.full_name, o.granted_at,
    o.revoked_at, r.full_name, o.revoke_reason
  from app.platform_operators o
  join app.people p on p.id = o.person_id
  left join auth.users u on u.id = p.user_id
  left join app.people g on g.id = o.granted_by
  left join app.people r on r.id = o.revoked_by
  where o.deleted_at is null
  order by o.revoked_at is not null, p.full_name nulls last, o.granted_at;
end;
$$;

comment on function app.console_operators() is 'The operator roster with who granted and revoked each role (operators.manage). Live grants first.';
revoke all on function app.console_operators() from public, anon;
grant execute on function app.console_operators() to authenticated;

create or replace function private.grant_operator_role(
  p_email text,
  p_role app.platform_operator_role,
  p_reason text,
  p_granted_by uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_id uuid;
begin
  if p_role is null then
    perform private.refuse('operator_role_required', 'Choose the operator role.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('operator_reason', 'Say why this person joins the platform team, in up to 500 characters.');
  end if;
  select p.id into v_person from auth.users u join app.people p on p.user_id = u.id and p.deleted_at is null
  where lower(u.email) = lower(btrim(p_email));
  if v_person is null then
    perform private.refuse('operator_no_account', 'No account uses that email. The person signs up once, then gets the role.');
  end if;
  if v_person = p_granted_by then
    perform private.refuse('operator_self', 'An operator never grants themselves a role.');
  end if;
  if exists (select 1 from app.platform_operators o where o.person_id = v_person and o.revoked_at is null and o.deleted_at is null) then
    perform private.refuse('operator_exists', 'This person is already on the platform team. Revoke the role first to change it.');
  end if;
  insert into app.platform_operators (person_id, operator_role, reason, granted_by)
  values (v_person, p_role, btrim(p_reason), p_granted_by)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.grant_operator_role(text, app.platform_operator_role, text, uuid) is 'Grants an operator role to the person whose account uses the email: one live grant per person, never to the granter.';
revoke all on function private.grant_operator_role(text, app.platform_operator_role, text, uuid) from public, anon, authenticated;

create or replace function private.grant_platform_operator(p_email text, p_role app.platform_operator_role, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.current_person_id() is not null then
    raise exception using errcode = '42501', message = 'only the platform names operators outside the console';
  end if;
  return private.grant_operator_role(p_email, p_role, p_reason, null);
end;
$$;

comment on function private.grant_platform_operator(text, app.platform_operator_role, text) is 'For the platform (service role or the SQL editor, never a signed-in person): grants an operator role by account email, for the first Administrator. Administrators then use app.console_grant_operator.';
revoke all on function private.grant_platform_operator(text, app.platform_operator_role, text) from public, anon, authenticated;
grant execute on function private.grant_platform_operator(text, app.platform_operator_role, text) to service_role;

create or replace function app.console_grant_operator(p_email text, p_role app.platform_operator_role, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_platform_operator('operators.manage');
  v_id uuid;
begin
  v_id := private.grant_operator_role(p_email, p_role, p_reason, v_admin);
  perform private.log_operator_action('platform_operator.granted', null, 'app.platform_operators', v_id, p_reason,
    jsonb_build_object('role', p_role));
  return v_id;
end;
$$;

comment on function app.console_grant_operator(text, app.platform_operator_role, text) is 'An Administrator (operators.manage) adds a person to the platform team by account email, with a role and a reason. Never to themselves. Returns the grant id.';
revoke all on function app.console_grant_operator(text, app.platform_operator_role, text) from public, anon;
grant execute on function app.console_grant_operator(text, app.platform_operator_role, text) to authenticated;

create or replace function app.console_revoke_operator(p_operator_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_platform_operator('operators.manage');
  v_row app.platform_operators;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('operator_reason', 'Say why the role is revoked, in up to 500 characters.');
  end if;
  select * into v_row from app.platform_operators o where o.id = p_operator_id and o.deleted_at is null for update;
  if v_row.id is null then
    raise exception using errcode = '42501', message = 'operator grant not found';
  end if;
  if v_row.revoked_at is not null then
    perform private.refuse('operator_revoked', 'This role was already revoked.');
  end if;
  if v_row.operator_role = 'Administrator' and not exists (
    select 1 from app.platform_operators o
    where o.operator_role = 'Administrator' and o.revoked_at is null and o.deleted_at is null and o.id <> v_row.id) then
    perform private.refuse('operator_last_administrator', 'The platform team keeps at least one Administrator. Grant another first.');
  end if;
  update app.platform_operators set revoked_at = now(), revoked_by = v_admin, revoke_reason = btrim(p_reason)
  where id = v_row.id;
  perform private.log_operator_action('platform_operator.revoked', null, 'app.platform_operators', v_row.id, p_reason,
    jsonb_build_object('role', v_row.operator_role));
  return v_row.id;
end;
$$;

comment on function app.console_revoke_operator(uuid, text) is 'An Administrator (operators.manage) revokes an operator role with a reason. The last Administrator stays. Returns the grant id.';
revoke all on function app.console_revoke_operator(uuid, text) from public, anon;
grant execute on function app.console_revoke_operator(uuid, text) to authenticated;

create or replace function app.console_action_log(p_target_org_id uuid default null, p_limit integer default 100)
returns table (
  id uuid,
  operator_name text,
  action text,
  target_org_id uuid,
  target_org_name text,
  subject_table text,
  subject_id uuid,
  reason text,
  details jsonb,
  acted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select a.id, p.full_name, a.action, a.target_org_id, o.name, a.subject_table, a.subject_id, a.reason, a.details, a.acted_at
  from app.platform_operator_actions a
  join app.people p on p.id = a.operator_person_id
  left join app.organizations o on o.id = a.target_org_id
  where p_target_org_id is null or a.target_org_id = p_target_org_id
  order by a.acted_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

comment on function app.console_action_log(uuid, integer) is 'The console ledger, newest first, for one tenant or all (tenants.read): who acted, what, on which tenant and why.';
revoke all on function app.console_action_log(uuid, integer) from public, anon;
grant execute on function app.console_action_log(uuid, integer) to authenticated;

-- Retention --------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.platform_operators', 'Age', 'revoked_at', interval '7 years', 'Delete', 'Who held console access is a compliance record (Section 8), kept 7 years after the role ends.'),
  ('app.platform_operator_actions', 'Age', 'acted_at', interval '7 years', 'Delete', 'Console actions are a compliance record, kept like the audit ledger.');
