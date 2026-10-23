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
--     checkout and portal actions call requireSecondFactor in their server actions (ADR 0055, decision 13).
--   * A79's partner exit (app.leave_partner, 1354) ends the partner-billed subscription and starts the org's own trial,
--     so it asks for step-up too. A79's org deletion and ownership transfer already do (1351, 1352, 1356).
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

-- A79's partner exit (1354, its only definition, every rule kept): a client org leaving its partner ends the
-- partner-billed subscription and starts its own trial, so the Owner steps up first.
create or replace function app.leave_partner(p_org_id uuid, p_confirm_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org app.organizations;
  v_partner uuid;
  v_brand record;
  v_sub app.subscriptions;
  v_staff uuid;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  v_partner := v_org.parent_org_id;
  if v_partner is null then
    perform private.refuse('leave_partner_no_partner', 'This organization is already a direct customer.');
  end if;
  if p_confirm_name is null or btrim(p_confirm_name) <> v_org.name then
    perform private.refuse('org_name_mismatch', 'Type the organization''s name exactly to confirm.');
  end if;
  if private.org_read_only(p_org_id) then
    perform private.refuse('org_read_only', 'A read-only organization cannot leave its partner.');
  end if;
  -- A99 (S9-08): leaving ends the partner-billed subscription, a billing change.
  perform private.require_second_factor('leave your partner');

  -- 1. The brand it renders with now becomes its own.
  select * into v_brand from private.public_brand(p_org_id);
  if exists (select 1 from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null) then
    if exists (select 1 from app.org_brands b where b.org_id = p_org_id and b.deleted_at is null) then
      update app.org_brands b
      set accent_hex = v_brand.accent_hex, neutral_tint_hex = v_brand.neutral_tint_hex, font_family = v_brand.font_family,
        radius_scale = v_brand.radius_scale,
        email_sender_name = coalesce(b.email_sender_name, (select d.email_sender_name from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null)),
        support_email = coalesce(b.support_email, (select d.support_email from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null))
      where b.org_id = p_org_id and b.deleted_at is null;
    else
      insert into app.org_brands (org_id, accent_hex, neutral_tint_hex, font_family, radius_scale, email_sender_name, support_email)
      select p_org_id, v_brand.accent_hex, v_brand.neutral_tint_hex, v_brand.font_family, v_brand.radius_scale,
        d.email_sender_name, d.support_email
      from app.partner_default_brands d where d.org_id = v_partner and d.deleted_at is null;
    end if;
  end if;

  -- 2. The partner's access ends: support sessions and standing grants.
  update app.record_grants g set valid_to = greatest(now(), g.valid_from)
  where g.id in (select sg.record_grant_id from app.support_session_grants sg
                 join app.support_sessions s on s.id = sg.support_session_id
                 where s.org_id = p_org_id and s.ended_at is null and s.ends_at > now())
     or g.id in (select pg.record_grant_id from app.partner_standing_grants pg
                 where pg.org_id = p_org_id and pg.ended_at is null and pg.valid_to > now());
  update app.support_sessions set ended_at = now(), ended_by = v_person
  where org_id = p_org_id and ended_at is null and ends_at > now();
  update app.partner_standing_grants set ended_at = now(), ended_by = v_person
  where org_id = p_org_id and ended_at is null and valid_to > now();
  update app.record_grants g set valid_to = greatest(now(), g.valid_from)
  where g.org_id = p_org_id and g.grantee_org_id = v_partner and g.valid_to > now();

  -- 3. The partner stops pricing the org, then the org stops being a client.
  update app.partner_client_prices set deleted_at = now()
  where org_id = v_partner and client_org_id = p_org_id and deleted_at is null;
  update app.organizations set parent_org_id = null where id = p_org_id;

  -- 4. Billing moves to the org: the partner-billed subscription ends and a direct trial of the same plan starts. The
  --    billing_handover mark tells plan-change triggers the plan never lapsed (1355: no white label downgrade notice).
  perform private.begin_trusted_operation('billing_handover');
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;
  if v_sub.id is not null then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled', 'Left the partner; billing moved to the organization.');
  end if;
  if coalesce(v_sub.plan_code, 'access') = 'access' then
    perform private.create_subscription(p_org_id, 'access');
  else
    perform private.start_trial(p_org_id, v_sub.plan_code, private.org_window_end(p_org_id, private.trial_days()),
      format('Left the partner: the %s plan continues for 14 days and stays once a card is added.', v_sub.plan_code));
  end if;
  perform private.end_trusted_operation('billing_handover');

  -- 5. Both sides are told.
  for v_staff in
    select distinct m.person_id from app.memberships m
    where m.org_id = v_partner and m.deleted_at is null and m.valid_from <= now() and m.valid_to is null
      and private.person_capability_reach(m.person_id, v_partner, 'org.partner.manage', false) = 'organization'
  loop
    perform private.notify(v_partner, v_staff, 'partner.client_left', 'app.organizations', p_org_id, null,
      jsonb_build_object('org', v_org.name));
  end loop;
  return p_org_id;
end;
$$;

comment on function app.leave_partner(uuid, text) is 'A client org leaves its partner and becomes a direct customer (Section 4.6.1): the Owner (org.billing.manage) types the org name. The brand it renders with now becomes its own, the partner''s support sessions, standing grants and other record grants end, the partner''s price for it is removed, it stops being a client, and the partner-billed subscription ends with a 14-day trial of the same plan that converts once a card is added (Access stays Access). Data and members are untouched; the partner''s staff are told. Needs step-up (a second factor in the last 15 minutes, A99): leaving changes how the org is billed. Returns the org id.';
