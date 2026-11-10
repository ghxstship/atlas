-- 6870_partner_client_creation.sql
-- A partner creates client organizations only once a platform operator turns that on for it (owner decision of
-- 2026-11-06 on the AI legal audit, item 17, made by AI with no attorney). It is off by default, so no partner-billed
-- client opens until GHXSTSHIP holds a signed partner agreement with that partner.
--   * private.partner_client_grants holds one row per partner organization that may create clients, with the
--     operator and the reason. Turning it on or off lands in app.platform_operator_actions.
--   * A trigger on app.organizations refuses a new client organization under a partner without a grant, whichever
--     function inserts it, so app.create_client_organization is covered at any signature it has or later gains.
--   * app.partner_client_creation_allowed tells the partner console whether to offer the create action.
--   * app.console_partner_client_grant and app.console_set_partner_clients show and change the setting in the
--     operator console. Turning it off leaves existing client organizations as they are.

create table private.partner_client_grants (
  org_id uuid primary key references app.organizations (id) on delete cascade,
  reason text not null,
  granted_by uuid not null references app.people (id),
  granted_at timestamptz not null default now(),
  constraint partner_client_grants_reason_length check (char_length(btrim(reason)) between 1 and 500)
);
create index partner_client_grants_granted_by_idx on private.partner_client_grants (granted_by);

comment on table private.partner_client_grants is 'Partner organizations a platform operator has allowed to create client organizations (item 17 of the AI legal audit). No row means off, the default. Written only by app.console_set_partner_clients; turning it off deletes the row, and the console ledger keeps both changes.';
comment on column private.partner_client_grants.org_id is 'The partner organization.';
comment on column private.partner_client_grants.reason is 'Why it is on, in the operator''s words, such as the signed partner agreement it rests on.';
comment on column private.partner_client_grants.granted_by is 'Operator who turned it on.';
comment on column private.partner_client_grants.granted_at is 'When it was turned on.';

alter table private.partner_client_grants enable row level security;
revoke all on private.partner_client_grants from public, anon, authenticated;
grant select on private.partner_client_grants to service_role;

create or replace function private.partner_clients_allowed(p_partner_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.partner_client_grants g where g.org_id = p_partner_org_id);
$$;

comment on function private.partner_clients_allowed(uuid) is 'True when a platform operator has allowed the organization to create client organizations (private.partner_client_grants).';
revoke all on function private.partner_clients_allowed(uuid) from public, anon, authenticated;

create or replace function private.guard_partner_client_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.partner_clients_allowed(new.parent_org_id) then
    perform private.refuse('partner_clients_not_enabled',
      'Creating client organizations is not turned on for this organization. The platform team turns it on under a signed partner agreement.');
  end if;
  return new;
end;
$$;

comment on function private.guard_partner_client_grant() is 'Refuses a new client organization under a partner that no platform operator has allowed to create clients (private.partner_client_grants). Runs after the depth check (t40).';
revoke all on function private.guard_partner_client_grant() from public, anon, authenticated;

create trigger t41_guard_partner_client_grant before insert on app.organizations
  for each row when (new.parent_org_id is not null) execute function private.guard_partner_client_grant();

create or replace function app.partner_client_creation_allowed(p_partner_org_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  return private.partner_clients_allowed(p_partner_org_id);
end;
$$;

comment on function app.partner_client_creation_allowed(uuid) is 'Partner console (Section 4.6.1): whether a platform operator has allowed this partner to create client organizations. Off by default. Needs org.partner.manage in the partner org.';
revoke all on function app.partner_client_creation_allowed(uuid) from public, anon;
grant execute on function app.partner_client_creation_allowed(uuid) to authenticated, service_role;

create or replace function app.console_partner_client_grant(p_org_id uuid)
returns table (allowed boolean, reason text, granted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('tenants.read');
  return query
  select g.org_id is not null, g.reason, g.granted_at
  from (select 1) one
  left join private.partner_client_grants g on g.org_id = p_org_id;
end;
$$;

comment on function app.console_partner_client_grant(uuid) is 'Operator console (tenants.read): whether the organization may create client organizations, with the reason and when it was turned on.';
revoke all on function app.console_partner_client_grant(uuid) from public, anon;
grant execute on function app.console_partner_client_grant(uuid) to authenticated;

create or replace function app.console_set_partner_clients(p_org_id uuid, p_allowed boolean, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('plans.write');
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('partner_clients_reason',
      'Say why, in up to 500 characters. To turn it on, name the signed partner agreement.');
  end if;
  if p_allowed is null then
    perform private.refuse('partner_clients_shape', 'Choose on or off.');
  end if;
  if p_allowed and not private.is_partner_capable(p_org_id) then
    perform private.refuse('partner_is_client', 'A client organization cannot have clients of its own.');
  end if;
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if p_allowed = private.partner_clients_allowed(p_org_id) then
    perform private.refuse('partner_clients_unchanged', 'Creating client organizations is already in that state for this organization.');
  end if;
  if p_allowed then
    insert into private.partner_client_grants (org_id, reason, granted_by) values (p_org_id, btrim(p_reason), v_operator);
  else
    delete from private.partner_client_grants g where g.org_id = p_org_id;
  end if;
  perform private.log_operator_action(case when p_allowed then 'partner_clients.enabled' else 'partner_clients.disabled' end,
    p_org_id, null, null, p_reason, '{}'::jsonb);
  return p_allowed;
end;
$$;

comment on function app.console_set_partner_clients(uuid, boolean, text) is 'An Administrator (plans.write) turns client organization creation on or off for a partner, with a reason, on the console ledger. Off by default (item 17 of the AI legal audit). Turning it off stops new client organizations and leaves existing ones as they are. Refuses partner_is_client for a client organization and partner_clients_unchanged when it is already in that state.';
revoke all on function app.console_set_partner_clients(uuid, boolean, text) from public, anon;
grant execute on function app.console_set_partner_clients(uuid, boolean, text) to authenticated;
