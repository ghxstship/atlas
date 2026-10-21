-- 1562_step_up_roles_keys_billing.sql
-- A99 Authentication follow-ups (RRR-144; finding A65-002, trace row S9-08, ADR 0055). Section 9: "Step-up
-- authentication is required for billing, data export, role changes and API key creation." Data export has used
-- step-up since 0530; these three now call the one check A77 built, private.require_second_factor (1333), with recency
-- (a second factor in the last 15 minutes), because each changes who holds the org or what a credential may do:
--
--   * Role changes: private.guard_membership_role (latest definition 0204, every rule kept) asks for step-up when a
--     person assigns a role to someone else or removes someone else's role. Joins the platform makes (invitations
--     accepted, single sign-on, SCIM, org creation) run as the platform or in a trusted operation and are not asked.
--   * API key creation: app.create_api_key (latest definition 0921; the service-account overload of 0922 delegates to
--     it). An API key or an OAuth app can never create a key (step_up_session_only).
--   * Billing: Atlas has no billing change in this release. Its Billing and Plan buttons stay disabled until Stripe is
--     connected, the billing service writes the subscription tables with the service role, and signed-in callers hold
--     no write privilege on them. 0205's policies would still let org.billing.manage write them if a grant were ever
--     added, so restrictive policies keep step-up in force there. A79's plan and lifecycle actions and the future
--     checkout and portal actions call requireSecondFactor in their server actions (ADR 0055, decision 6).
-- Personal access tokens (A86) use the same check when they land.

create or replace function private.guard_membership_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_trusted boolean := private.in_trusted_operation('membership_write');
  v_me uuid := private.current_person_id();
  v_row app.membership_roles := case when tg_op = 'DELETE' then old else new end;
  v_member app.memberships;
  v_role app.roles;
  v_old_band smallint;
  v_counts record;
  v_removing boolean;
begin
  select * into v_member from app.memberships m where m.id = v_row.membership_id;
  select * into v_role from app.roles r where r.id = v_row.role_id;

  if tg_op = 'UPDATE' then
    if new.membership_id <> old.membership_id or new.role_id <> old.role_id then
      perform private.refuse('role_assignment_immutable', 'Change a role by removing it and assigning another.');
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('role_assignment_immutable', 'Assign a removed role again with a new row.');
    end if;
  end if;

  if not v_platform and not v_trusted and v_me is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;

  v_removing := tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null);

  if v_removing then
    if not v_platform and not v_trusted and v_member.person_id <> v_me then
      if not private.has_capability(v_row.org_id, 'org.members.manage') then
        raise exception using errcode = '42501', message = 'org.members.manage is required';
      end if;
      if coalesce(private.best_band(v_me, v_row.org_id), 8) > v_role.band then
        perform private.refuse('role_band', 'A person can remove only roles at or below their own band.');
      end if;
      -- A99 (S9-08): removing someone else's role is a role change.
      perform private.require_second_factor('change a member''s role');
    end if;
    if v_role.org_id is null and v_role.code = 'owner' then
      perform private.assert_other_owner(v_row.org_id, v_row.membership_id);
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE' then
    return new;
  end if;

  -- Insert: a new role assignment.
  if v_role.deleted_at is not null then
    perform private.refuse('role_removed', 'A removed role cannot be assigned.');
  end if;
  if v_member.deleted_at is not null or (v_member.valid_to is not null and v_member.valid_to <= now()) then
    perform private.refuse('membership_ended', 'Roles cannot be assigned to an ended membership.');
  end if;

  if not v_platform and not v_trusted then
    if v_member.person_id = v_me then
      perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
    end if;
    if not private.has_capability(new.org_id, 'org.members.manage') then
      raise exception using errcode = '42501', message = 'org.members.manage is required';
    end if;
    if coalesce(private.best_band(v_me, new.org_id), 8) > v_role.band then
      perform private.refuse('role_band', 'A person can assign only roles at or below their own band.');
    end if;
    perform private.assert_holds_role_capabilities(v_me, new.org_id, new.role_id);
    -- A99 (S9-08): assigning someone a role is a role change.
    perform private.require_second_factor('change a member''s role');
    new.granted_by := v_me;
  end if;

  -- Plan limits: seats above Field, metered field members (Section 16).
  perform 1 from app.organizations o where o.id = new.org_id for update;
  select min(r.band) into v_old_band
  from app.membership_roles mr join app.roles r on r.id = mr.role_id and r.deleted_at is null
  where mr.membership_id = new.membership_id and mr.deleted_at is null;
  select * into v_counts from private.membership_band_counts(new.org_id);
  if v_role.band <= 5 and (v_old_band is null or v_old_band > 5) then
    perform private.assert_within_plan_limit(new.org_id, 'seats', v_counts.seats + 1);
  elsif v_role.band = 6 and (v_old_band is null or v_old_band > 6) then
    perform private.assert_within_plan_limit(new.org_id, 'field_members', v_counts.field_members + 1);
  end if;
  return new;
end;
$$;

comment on function private.guard_membership_role() is 'Role assignments: no self-grant (Section 8.2), assigner needs org.members.manage, a band at or above the role and every capability the role grants, and step-up (a second factor in the last 15 minutes, S9-08) to assign or remove someone else''s role; seat and field plan limits; the sole Owner cannot be demoted (Section 7.5 invariant 4).';

create or replace function app.create_api_key(p_org_id uuid, p_name text, p_scopes text[], p_expires_at timestamptz)
returns table (api_key_id uuid, secret text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret text := 'xos_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.api_keys.manage') then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if not private.org_has_feature(p_org_id, 'api_keys') then
    perform private.refuse('plan_feature_required', 'API keys need the Pro plan or above.');
  end if;
  -- A99 (S9-08): a new credential needs a second factor passed in the last 15 minutes.
  perform private.require_second_factor('create an API key');
  insert into app.api_keys (org_id, name, scopes, expires_at, prefix, secret_hash)
  values (p_org_id, btrim(p_name), coalesce((select array_agg(distinct s order by s) from unnest(p_scopes) s), '{}'),
    p_expires_at, left(v_secret, 17), extensions.digest(v_secret, 'sha256'))
  returning id into v_id;
  return query select v_id, v_secret;
end;
$$;

comment on function app.create_api_key(uuid, text, text[], timestamptz) is 'Creates an API key and returns its secret once; only the SHA-256 hash is stored. Needs org.api_keys.manage, the api_keys plan feature and step-up (a second factor in the last 15 minutes; never an API key or an app).';

create or replace function private.billing_step_up(p_org_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Someone without org.billing.manage is refused by the permissive policies; step-up is asked only of those it would
  -- let through.
  if private.has_capability(p_org_id, 'org.billing.manage') then
    perform private.require_second_factor('change billing');
  end if;
  return true;
end;
$$;

comment on function private.billing_step_up(uuid) is 'Restrictive policy check on the subscription tables: a signed-in caller who may change the org''s billing (org.billing.manage) must have passed a second factor in the last 15 minutes, or the write is refused step_up_required (S9-08). True otherwise. Functions write as the table owner and the billing service as the service role, so neither is asked.';
revoke all on function private.billing_step_up(uuid) from public, anon;
grant execute on function private.billing_step_up(uuid) to authenticated;

-- Restrictive policies apply only to a signed-in caller''s own writes through row level security, alongside the
-- permissive ones of 0205.
create policy subscriptions_step_up_insert on app.subscriptions as restrictive for insert to authenticated
  with check (private.billing_step_up(org_id));
create policy subscriptions_step_up_update on app.subscriptions as restrictive for update to authenticated
  using (private.billing_step_up(org_id)) with check (private.billing_step_up(org_id));
create policy subscriptions_step_up_delete on app.subscriptions as restrictive for delete to authenticated
  using (private.billing_step_up(org_id));
create policy subscription_state_transitions_step_up_insert on app.subscription_state_transitions as restrictive
  for insert to authenticated with check (private.billing_step_up(org_id));
