-- 0204_access_helpers.sql
-- A02 Platform Data. RLS helpers and identity invariants (Section 8, Section 7.5).
--
-- Helpers (all SECURITY DEFINER, search_path pinned, executable by authenticated, never anon):
--   private.current_person_id()                      signed-in person (0202)
--   private.is_member(org_id)                        active membership now
--   private.my_org_ids(), private.my_membership_ids() set forms for initplan-friendly policies
--   private.has_capability(org_id, capability, scope) capability check used by every policy
--   private.capability_reach(org_id, capability)     widest reach held
--   private.orgs_with_capability(capability)         orgs where the reach is organization-wide
--   private.is_assigned_to_scope(org_id, scope_id)   assignment seam; A03 and A30 extend it
--   private.scope_org(kind, id)                      owning org of a grant target; A03 extends it
--
-- Capability union (Section 4.8.1): a person's reach on a capability in an org is the widest of
--   every role held through an active membership, org-wide direct grants, org-level record
--   grants to the person or to an org they actively belong to, and one-hop delegations.
-- Time boxes (Section 8): memberships, grants and delegations count only between valid_from
--   and valid_to, evaluated at now().

-- Membership sets ----------------------------------------------------------------------------

create or replace function private.my_membership_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.my_membership_ids() is 'Active memberships of the signed-in person.';

create or replace function private.my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m
  where m.person_id = private.current_person_id()
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.my_org_ids() is 'Orgs where the signed-in person holds an active membership.';

create or replace function private.is_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.my_org_ids() o where o = p_org_id);
$$;

comment on function private.is_member(uuid) is 'True when the signed-in person holds an active membership in the org (Section 7.5 invariant 3: leaving ends access at once).';

create or replace function private.person_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id from app.memberships m
  where m.person_id = p_person_id
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.person_org_ids(uuid) is 'Orgs where a person holds an active membership.';

create or replace function private.visible_person_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_person_id()
  union
  select m.person_id from app.memberships m
  where m.org_id in (select private.my_org_ids())
    and m.deleted_at is null
    and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.visible_person_ids() is 'The signed-in person and everyone holding an active membership in an org they actively belong to.';

create or replace function private.best_band(p_person_id uuid, p_org_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select min(r.band) from app.memberships m
  join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
  join app.roles r on r.id = mr.role_id and r.deleted_at is null
  where m.person_id = p_person_id and m.org_id = p_org_id
    and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.best_band(uuid, uuid) is 'Highest-ranking (lowest numbered) band among the roles a person holds in an org now; null without roles.';

-- Scope resolution -----------------------------------------------------------------------------

create or replace function private.scope_org(p_kind app.grant_target_kind, p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  case p_kind
    when 'organization' then
      return (select o.id from app.organizations o where o.id = p_id);
    when 'workspace' then
      return (select w.org_id from app.workspaces w where w.id = p_id);
    when 'team' then
      return (select t.org_id from app.teams t where t.id = p_id);
    else
      -- project and record targets resolve once A03 replaces this function with their tables.
      return null;
  end case;
end;
$$;

comment on function private.scope_org(app.grant_target_kind, uuid) is 'Owning org of a grant target, or null when the target is unknown. A03 replaces this function to resolve project and record targets.';

create or replace function private.is_assigned_to_scope(p_org_id uuid, p_scope_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.workspace_members wm
    where wm.workspace_id = p_scope_id and wm.org_id = p_org_id and wm.deleted_at is null
      and wm.membership_id in (select private.my_membership_ids())
  ) or exists (
    select 1 from app.team_members tm
    where tm.team_id = p_scope_id and tm.org_id = p_org_id and tm.deleted_at is null
      and tm.membership_id in (select private.my_membership_ids())
  );
$$;

comment on function private.is_assigned_to_scope(uuid, uuid) is 'True when the signed-in person is assigned to the scope (workspace or team today). A03 and A30 replace this function to add project assignments.';

-- Capability reach -----------------------------------------------------------------------------

create or replace function private.person_capability_reach(
  p_person_id uuid,
  p_org_id uuid,
  p_capability text,
  p_include_delegations boolean
)
returns app.capability_reach
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_person_id is null or p_org_id is null then
    return null;
  end if;
  return (
    select max(s.reach) from (
      select rc.reach
      from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
      join app.roles r on r.id = mr.role_id and r.deleted_at is null
      join app.role_capabilities rc on rc.role_id = r.id and rc.deleted_at is null
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and rc.capability_code = p_capability
      union all
      select 'organization'::app.capability_reach
      from app.user_capability_grants g
      join app.memberships m on m.id = g.membership_id
      where m.person_id = p_person_id and m.org_id = p_org_id
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        and g.capability_code = p_capability and g.scope_id is null and g.deleted_at is null
        and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
      union all
      select 'organization'::app.capability_reach
      from app.record_grants rg
      where rg.org_id = p_org_id and rg.target_kind = 'organization' and rg.target_id = p_org_id
        and rg.capability_code = p_capability and rg.deleted_at is null
        and rg.valid_from <= now() and rg.valid_to > now()
        and (rg.grantee_person_id = p_person_id
             or rg.grantee_org_id in (select private.person_org_ids(p_person_id)))
      union all
      select private.person_capability_reach(dm.person_id, p_org_id, p_capability, false)
      from app.delegations d
      join app.memberships em on em.id = d.delegate_membership_id
      join app.memberships dm on dm.id = d.delegator_membership_id
      where p_include_delegations
        and d.org_id = p_org_id and d.deleted_at is null
        and d.valid_from <= now() and d.valid_to > now()
        and em.person_id = p_person_id
        and em.deleted_at is null and em.valid_from <= now() and (em.valid_to is null or em.valid_to > now())
        and dm.deleted_at is null and dm.valid_from <= now() and (dm.valid_to is null or dm.valid_to > now())
        and (d.capability_code = p_capability
             or (d.capability_code is null and exists (
               select 1 from app.capabilities c where c.code = p_capability and c.capability_class = 'approve')))
    ) s
  );
end;
$$;

comment on function private.person_capability_reach(uuid, uuid, text, boolean) is 'Widest reach a person holds on a capability in an org now: the union of roles, org-wide direct grants, org-level record grants and, when asked, one-hop delegations.';

create or replace function private.capability_reach(p_org_id uuid, p_capability text)
returns app.capability_reach
language sql
stable
security definer
set search_path = ''
as $$
  select private.person_capability_reach(private.current_person_id(), p_org_id, p_capability, true);
$$;

comment on function private.capability_reach(uuid, text) is 'Widest reach the signed-in person holds on a capability in an org, or null.';

create or replace function private.has_capability(p_org_id uuid, p_capability text, p_scope uuid default null)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_reach app.capability_reach;
begin
  if not exists (select 1 from app.capabilities c where c.code = p_capability) then
    raise exception using errcode = '22023', message = format('unknown capability %s', p_capability);
  end if;
  if v_person is null or p_org_id is null then
    return false;
  end if;
  v_reach := private.person_capability_reach(v_person, p_org_id, p_capability, true);
  if v_reach = 'organization' then
    return true;
  end if;
  if p_scope is null then
    return false;
  end if;
  if v_reach is not null and p_scope = v_person then
    return true;
  end if;
  if v_reach = 'assigned' and private.is_assigned_to_scope(p_org_id, p_scope) then
    return true;
  end if;
  return exists (
    select 1 from app.user_capability_grants g
    where g.org_id = p_org_id and g.scope_id = p_scope and g.capability_code = p_capability
      and g.deleted_at is null and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
      and g.membership_id in (select private.my_membership_ids())
  ) or exists (
    select 1 from app.record_grants rg
    where rg.org_id = p_org_id and rg.target_id = p_scope and rg.capability_code = p_capability
      and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
      and (rg.grantee_person_id = v_person or rg.grantee_org_id in (select private.my_org_ids()))
  );
end;
$$;

comment on function private.has_capability(uuid, text, uuid) is 'Section 8 capability check. True when the signed-in person holds the capability org-wide, or, for a scope: on their own person id (own reach), on a workspace or team they are assigned to (assigned reach), or through a grant scoped to it. Raises on an unknown capability code.';

create or replace function private.orgs_with_capability(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.org_id from (
    select org_id from private.my_org_ids() as org_id
    union
    select rg.org_id from app.record_grants rg
    where rg.target_kind = 'organization' and rg.target_id = rg.org_id
      and rg.capability_code = p_capability and rg.deleted_at is null
      and rg.valid_from <= now() and rg.valid_to > now()
      and (rg.grantee_person_id = private.current_person_id()
           or rg.grantee_org_id in (select private.my_org_ids()))
  ) o
  where private.person_capability_reach(private.current_person_id(), o.org_id, p_capability, true) = 'organization';
$$;

comment on function private.orgs_with_capability(text) is 'Orgs where the signed-in person holds the capability org-wide. Policies use it as org_id in (select ...) so it runs once per statement.';

-- Plan limits (Section 16) ------------------------------------------------------------------------

create or replace view private.org_plan_limits as
select o.id as org_id, p.plan_code, pl.limit_code, pl.limit_value
from app.organizations o
cross join lateral (
  select coalesce(
    (select s.plan_code from app.subscriptions s
     where s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null),
    'access'
  ) as plan_code
) p
join private.plan_limits pl on pl.plan_code = p.plan_code;

comment on view private.org_plan_limits is 'Each org''s effective plan limits. An org without a current subscription is held to the Access plan. Downgrades never delete data.';
comment on column private.org_plan_limits.org_id is 'Organization.';
comment on column private.org_plan_limits.plan_code is 'Plan in force: the current subscription''s plan, or access.';
comment on column private.org_plan_limits.limit_code is 'Countable limit.';
comment on column private.org_plan_limits.limit_value is 'Maximum count, or null for unlimited.';

revoke all on private.org_plan_limits from public, anon, authenticated;
grant select on private.org_plan_limits to service_role;

create or replace function private.plan_limit(p_org_id uuid, p_limit app.plan_limit_code)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select l.limit_value from private.org_plan_limits l where l.org_id = p_org_id and l.limit_code = p_limit;
$$;

comment on function private.plan_limit(uuid, app.plan_limit_code) is 'Limit in force for an org, or null when unlimited.';

create or replace function private.org_has_feature(p_org_id uuid, p_feature app.plan_feature_code)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.plan_features f
    where f.feature_code = p_feature
      and f.plan_code = (select distinct l.plan_code from private.org_plan_limits l where l.org_id = p_org_id)
  );
$$;

comment on function private.org_has_feature(uuid, app.plan_feature_code) is 'True when the org''s plan includes the feature.';

create or replace function private.assert_within_plan_limit(p_org_id uuid, p_limit app.plan_limit_code, p_prospective bigint)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit bigint := private.plan_limit(p_org_id, p_limit);
begin
  if v_limit is not null and p_prospective > v_limit then
    perform private.refuse('plan_limit_exceeded',
      format('The plan allows %s %s; this change needs %s.', v_limit, p_limit, p_prospective));
  end if;
end;
$$;

comment on function private.assert_within_plan_limit(uuid, app.plan_limit_code, bigint) is 'Refuses when a prospective count exceeds the org''s plan limit. Other ranges call it for projects and engagements.';

create or replace function private.membership_band_counts(p_org_id uuid)
returns table (seats bigint, field_members bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) filter (where b.band <= 5), count(*) filter (where b.band = 6)
  from (
    select min(r.band) as band
    from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.deleted_at is null
    where m.org_id = p_org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    group by m.id
  ) b;
$$;

comment on function private.membership_band_counts(uuid) is 'Seats (active members whose best band is above Field) and metered field members (best band Field) of an org (Section 16). Viewers count as neither.';

-- Subscription lifecycle ------------------------------------------------------------------------

create or replace function private.transition_subscription(
  p_subscription_id uuid,
  p_expected_state app.subscription_state,
  p_next_state app.subscription_state,
  p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if not exists (
    select 1 from app.subscription_state_transition_rules t
    where t.from_state = p_expected_state and t.to_state = p_next_state
  ) then
    perform private.refuse('subscription_transition_not_allowed',
      format('A subscription cannot move from %s to %s.', p_expected_state, p_next_state));
  end if;
  update app.subscriptions s set subscription_state = p_next_state
  where s.id = p_subscription_id and s.subscription_state = p_expected_state and s.deleted_at is null
  returning s.org_id into v_org_id;
  if v_org_id is null then
    perform private.refuse('subscription_state_conflict',
      'The subscription is not in the expected state.');
  end if;
  insert into app.subscription_state_transitions (subscription_id, from_state, to_state, reason)
  values (p_subscription_id, p_expected_state, p_next_state, p_reason);
end;
$$;

comment on function private.transition_subscription(uuid, app.subscription_state, app.subscription_state, text) is 'The only writer of subscription_state after creation: compare-and-set on the expected state, checked against the transition rules, logged to the ledger. Called by billing services with the service role.';

-- Guards: owners ----------------------------------------------------------------------------------

create or replace function private.assert_other_owner(p_org_id uuid, p_excluding_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if not exists (
    select 1 from app.memberships m
    join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
    join app.roles r on r.id = mr.role_id and r.org_id is null and r.code = 'owner'
    where m.org_id = p_org_id and m.id <> p_excluding_membership_id
      and m.deleted_at is null and m.valid_from <= now() and m.valid_to is null
  ) then
    perform private.refuse('sole_owner',
      'An org keeps at least one Owner; the sole Owner cannot remove or demote themselves.');
  end if;
end;
$$;

comment on function private.assert_other_owner(uuid, uuid) is 'Section 7.5 invariant 4: refuses a change that would leave an org without an open-ended Owner. Locks the org row so concurrent demotions serialize.';

create or replace function private.holds_owner_role(p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.membership_roles mr
    join app.roles r on r.id = mr.role_id and r.org_id is null and r.code = 'owner'
    where mr.membership_id = p_membership_id and mr.deleted_at is null
  );
$$;

comment on function private.holds_owner_role(uuid) is 'True when a membership holds the Owner role.';

-- Guards: organizations ---------------------------------------------------------------------------

create or replace function private.guard_partner_depth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.parent_org_id is null then
    return new;
  end if;
  perform 1 from app.organizations o where o.id in (new.id, new.parent_org_id) order by o.id for update;
  if exists (select 1 from app.organizations p where p.id = new.parent_org_id and p.parent_org_id is not null) then
    perform private.refuse('partner_depth',
      'A partner cannot have a parent partner: the hierarchy is Platform, Partner org, Client org.');
  end if;
  if exists (select 1 from app.organizations c where c.parent_org_id = new.id) then
    perform private.refuse('partner_depth',
      'An org with client orgs is a partner and cannot become a client org.');
  end if;
  return new;
end;
$$;

comment on function private.guard_partner_depth() is 'Section 4.6.1: keeps the reseller hierarchy at three levels.';

create trigger t40_guard_partner_depth before insert or update of parent_org_id on app.organizations
  for each row execute function private.guard_partner_depth();

-- Guards: memberships ------------------------------------------------------------------------------

create or replace function private.guard_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_trusted boolean := private.in_trusted_operation('membership_write');
  v_me uuid := private.current_person_id();
  v_reducing boolean;
begin
  if tg_op = 'DELETE' then
    if not v_platform then
      perform private.refuse('membership_retained', 'Memberships are ended, never deleted.');
    end if;
    return old;
  end if;

  if not v_platform and not v_trusted and v_me is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;

  if tg_op = 'UPDATE' and new.person_id <> old.person_id then
    perform private.refuse('membership_person_immutable', 'A membership cannot move to another person.');
  end if;

  if new.deleted_at is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.org_id::text || new.person_id::text, 0));
    if exists (
      select 1 from app.memberships m
      where m.org_id = new.org_id and m.person_id = new.person_id and m.id <> new.id and m.deleted_at is null
        and tstzrange(m.valid_from, m.valid_to) && tstzrange(new.valid_from, new.valid_to)
    ) then
      perform private.refuse('membership_overlap', 'A person holds one membership per org at a time.');
    end if;
  end if;

  if tg_op = 'INSERT' then
    if not v_platform and not v_trusted then
      if new.person_id = v_me then
        perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
      end if;
      if not private.has_capability(new.org_id, 'org.members.manage') then
        raise exception using errcode = '42501', message = 'org.members.manage is required';
      end if;
    end if;
    return new;
  end if;

  v_reducing := (new.deleted_at is not null and old.deleted_at is null)
    or (new.valid_to is not null and (old.valid_to is null or new.valid_to < old.valid_to));

  if not v_platform and not v_trusted then
    if v_reducing and new.valid_from = old.valid_from
       and (new.deleted_at is not distinct from old.deleted_at or old.deleted_at is null) then
      if new.person_id <> v_me and not (
        private.has_capability(new.org_id, 'org.members.manage')
        and coalesce(private.best_band(v_me, new.org_id), 8) <= coalesce(private.best_band(new.person_id, new.org_id), 8)
      ) then
        raise exception using errcode = '42501',
          message = 'ending this membership needs org.members.manage at or above the member''s band';
      end if;
    else
      if new.person_id = v_me then
        perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
      end if;
      if not private.has_capability(new.org_id, 'org.members.manage') then
        raise exception using errcode = '42501', message = 'org.members.manage is required';
      end if;
    end if;
  end if;

  if v_reducing and private.holds_owner_role(new.id) then
    perform private.assert_other_owner(new.org_id, new.id);
  end if;
  return new;
end;
$$;

comment on function private.guard_membership() is 'Memberships: no overlapping periods, no self-granted access (Section 8.2), ending another member needs org.members.manage at or above their band, and the sole Owner cannot leave (Section 7.5 invariant 4).';

create trigger t40_guard_membership before insert or update or delete on app.memberships
  for each row execute function private.guard_membership();

-- Guards: role assignment ------------------------------------------------------------------------

create or replace function private.assert_holds_role_capabilities(p_person_id uuid, p_org_id uuid, p_role_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing text;
begin
  select rc.capability_code into v_missing
  from app.role_capabilities rc
  where rc.role_id = p_role_id and rc.deleted_at is null
    and coalesce(private.person_capability_reach(p_person_id, p_org_id, rc.capability_code, false) >= rc.reach, false) is false
  order by rc.capability_code
  limit 1;
  if v_missing is not null then
    perform private.refuse('grant_exceeds_holder',
      format('A person can grant only what they hold; %s is missing.', v_missing));
  end if;
end;
$$;

comment on function private.assert_holds_role_capabilities(uuid, uuid, uuid) is 'Refuses when the granting person does not hold every capability of a role at least as widely as the role grants it.';

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

comment on function private.guard_membership_role() is 'Role assignments: no self-grant (Section 8.2), assigner needs org.members.manage, a band at or above the role and every capability the role grants; seat and field plan limits; the sole Owner cannot be demoted (Section 7.5 invariant 4).';

create trigger t40_guard_membership_role before insert or update or delete on app.membership_roles
  for each row execute function private.guard_membership_role();

-- Guards: roles and role capabilities -------------------------------------------------------------

create or replace function private.guard_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_row app.roles := case when tg_op = 'DELETE' then old else new end;
begin
  if v_row.org_id is null then
    if not v_platform then
      perform private.refuse('system_role_immutable', 'Platform system roles change only through the capability registry.');
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    perform private.refuse('role_retained', 'Custom roles are removed by setting deleted_at.');
  end if;
  if tg_op = 'UPDATE' and (new.code <> old.code or new.band <> old.band) then
    perform private.refuse('role_definition_immutable', 'A custom role keeps its code and band; create another role instead.');
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from app.roles r where r.org_id is null and r.code = new.code) then
      perform private.refuse('role_code_reserved', format('%s is a platform role code.', new.code));
    end if;
    if not private.org_has_feature(new.org_id, 'custom_roles') then
      perform private.refuse('plan_feature_unavailable', 'Custom roles need the Team plan or above.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_role() is 'System roles are immutable outside the generated seed; custom roles need the custom_roles plan feature, never reuse a system code and keep their code and band.';

create trigger t40_guard_role before insert or update or delete on app.roles
  for each row execute function private.guard_role();

create or replace function private.guard_role_capability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_row app.role_capabilities := case when tg_op = 'DELETE' then old else new end;
  v_me uuid := private.current_person_id();
  v_reach app.capability_reach;
begin
  if v_platform then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_row.org_id is null then
    perform private.refuse('system_role_immutable', 'Platform system role grants change only through the capability registry.');
  end if;
  if tg_op = 'UPDATE' and (new.role_id <> old.role_id or new.capability_code <> old.capability_code or new.reach <> old.reach) then
    perform private.refuse('role_capability_immutable', 'Change a role capability by removing it and adding another.');
  end if;
  if tg_op = 'INSERT' then
    v_reach := private.person_capability_reach(v_me, new.org_id, new.capability_code, false);
    if v_reach is null or v_reach < new.reach then
      perform private.refuse('grant_exceeds_holder',
        format('A person can grant only what they hold; %s is missing.', new.capability_code));
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.guard_role_capability() is 'Custom role capabilities can only be ones the editor holds at least as widely; system role grants are immutable outside the generated seed.';

create trigger t40_guard_role_capability before insert or update or delete on app.role_capabilities
  for each row execute function private.guard_role_capability();

-- Guards: direct grants, record grants and delegations --------------------------------------------

create or replace function private.guard_user_capability_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_me uuid := private.current_person_id();
  v_scope_org uuid;
begin
  if tg_op = 'UPDATE' and (new.membership_id <> old.membership_id or new.capability_code <> old.capability_code
      or new.scope_id is distinct from old.scope_id or new.valid_from <> old.valid_from) then
    perform private.refuse('grant_immutable', 'Only the end of a grant can change.');
  end if;
  if new.scope_kind is not null then
    v_scope_org := private.scope_org(new.scope_kind, new.scope_id);
    if v_scope_org is null then
      perform private.refuse('scope_unknown', 'The grant scope does not resolve to an org.');
    end if;
    if v_scope_org <> new.org_id then
      perform private.refuse('cross_org_reference', 'user_capability_grants.scope_id points to a row of another org.');
    end if;
  end if;
  if v_platform then
    return new;
  end if;
  if v_me is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if (select m.person_id from app.memberships m where m.id = new.membership_id) = v_me
     and (tg_op = 'INSERT' or new.valid_to is distinct from old.valid_to and (new.valid_to is null or new.valid_to > old.valid_to)) then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if tg_op = 'INSERT' then
    if (new.scope_id is null and private.capability_reach(new.org_id, new.capability_code) is distinct from 'organization')
       or (new.scope_id is not null and not private.has_capability(new.org_id, new.capability_code, new.scope_id)) then
      perform private.refuse('grant_exceeds_holder',
        format('A person can grant only what they hold; %s is missing.', new.capability_code));
    end if;
    new.granted_by := v_me;
  end if;
  return new;
end;
$$;

comment on function private.guard_user_capability_grant() is 'Direct grants: scope in the same org, no self-grant (Section 8.2), grantor holds what they grant; only the end date changes afterwards.';

create trigger t40_guard_user_capability_grant before insert or update on app.user_capability_grants
  for each row execute function private.guard_user_capability_grant();

create or replace function private.guard_record_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_me uuid := private.current_person_id();
  v_target_org uuid;
begin
  if tg_op = 'UPDATE' then
    if new.target_kind <> old.target_kind or new.target_id <> old.target_id
       or new.capability_code <> old.capability_code or new.valid_from <> old.valid_from
       or new.grantee_person_id is distinct from old.grantee_person_id
       or new.grantee_org_id is distinct from old.grantee_org_id then
      perform private.refuse('grant_immutable', 'Only the end of a grant can change.');
    end if;
    if not v_platform and new.valid_to > old.valid_to then
      perform private.refuse('grant_immutable', 'A record grant can be shortened, not extended; issue a new grant.');
    end if;
    return new;
  end if;
  v_target_org := private.scope_org(new.target_kind, new.target_id);
  if v_target_org is null then
    perform private.refuse('scope_unknown', 'The grant target does not resolve to an org.');
  end if;
  new.org_id := v_target_org;
  if new.grantee_org_id = new.org_id then
    perform private.refuse('record_grant_own_org', 'Members of the owning org are granted access through roles.');
  end if;
  if v_platform then
    return new;
  end if;
  if v_me is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if new.grantee_person_id = v_me
     or new.grantee_org_id in (select private.my_org_ids()) then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if not private.has_capability(new.org_id, 'org.access_grants.manage') then
    raise exception using errcode = '42501', message = 'org.access_grants.manage is required';
  end if;
  if private.capability_reach(new.org_id, new.capability_code) is distinct from 'organization' then
    perform private.refuse('grant_exceeds_holder',
      format('A person can grant only what they hold; %s is missing.', new.capability_code));
  end if;
  new.granted_by := v_me;
  return new;
end;
$$;

comment on function private.guard_record_grant() is 'Record grants: org_id derived from the target, no grant to the owning org, no self-grant including through an org the grantor belongs to, grantor holds org.access_grants.manage and the capability; grants can be shortened, never extended.';

create trigger t10_derive_record_grant_org before insert or update on app.record_grants
  for each row execute function private.guard_record_grant();

create or replace function private.guard_delegation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform boolean := auth.uid() is null;
  v_me uuid := private.current_person_id();
  v_delegator uuid := (select m.person_id from app.memberships m where m.id = new.delegator_membership_id);
  v_delegate app.memberships;
begin
  if tg_op = 'UPDATE' and (new.delegate_membership_id <> old.delegate_membership_id
      or new.capability_code is distinct from old.capability_code or new.valid_from <> old.valid_from) then
    perform private.refuse('grant_immutable', 'Only the end of a delegation can change.');
  end if;
  if tg_op = 'UPDATE' and new.valid_to > old.valid_to and not v_platform then
    perform private.refuse('grant_immutable', 'A delegation can be shortened, not extended; create a new one.');
  end if;
  select * into v_delegate from app.memberships m where m.id = new.delegate_membership_id;
  if v_delegate.person_id = v_delegator then
    perform private.refuse('sod_self_grant', 'A person cannot delegate to themselves.');
  end if;
  if tg_op = 'INSERT' then
    if v_delegate.deleted_at is not null or (v_delegate.valid_to is not null and v_delegate.valid_to <= now()) then
      perform private.refuse('membership_ended', 'The delegate''s membership has ended.');
    end if;
    if new.capability_code is not null
       and private.person_capability_reach(v_delegator, new.org_id, new.capability_code, false) is null then
      perform private.refuse('grant_exceeds_holder',
        format('A person can delegate only what they hold; %s is missing.', new.capability_code));
    end if;
  end if;
  if v_platform then
    return new;
  end if;
  if v_me is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if v_delegate.person_id = v_me then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if v_delegator <> v_me and not private.has_capability(new.org_id, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'only the delegator or org.members.manage may set a delegation';
  end if;
  return new;
end;
$$;

comment on function private.guard_delegation() is 'Delegations: never to oneself, never self-serving (Section 8.2), only capabilities the delegator holds, to an active member; shortened, never extended.';

create trigger t40_guard_delegation before insert or update on app.delegations
  for each row execute function private.guard_delegation();

-- Privileges --------------------------------------------------------------------------------------

revoke all on function private.my_membership_ids() from public, anon;
revoke all on function private.my_org_ids() from public, anon;
revoke all on function private.is_member(uuid) from public, anon;
revoke all on function private.person_org_ids(uuid) from public, anon, authenticated;
revoke all on function private.visible_person_ids() from public, anon;
revoke all on function private.best_band(uuid, uuid) from public, anon, authenticated;
revoke all on function private.scope_org(app.grant_target_kind, uuid) from public, anon, authenticated;
revoke all on function private.is_assigned_to_scope(uuid, uuid) from public, anon;
revoke all on function private.person_capability_reach(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function private.capability_reach(uuid, text) from public, anon;
revoke all on function private.has_capability(uuid, text, uuid) from public, anon;
revoke all on function private.orgs_with_capability(text) from public, anon;
revoke all on function private.plan_limit(uuid, app.plan_limit_code) from public, anon, authenticated;
revoke all on function private.org_has_feature(uuid, app.plan_feature_code) from public, anon, authenticated;
revoke all on function private.assert_within_plan_limit(uuid, app.plan_limit_code, bigint) from public, anon, authenticated;
revoke all on function private.membership_band_counts(uuid) from public, anon, authenticated;
revoke all on function private.transition_subscription(uuid, app.subscription_state, app.subscription_state, text) from public, anon, authenticated;
revoke all on function private.assert_other_owner(uuid, uuid) from public, anon, authenticated;
revoke all on function private.holds_owner_role(uuid) from public, anon, authenticated;
revoke all on function private.assert_holds_role_capabilities(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.guard_partner_depth() from public, anon, authenticated;
revoke all on function private.guard_membership() from public, anon, authenticated;
revoke all on function private.guard_membership_role() from public, anon, authenticated;
revoke all on function private.guard_role() from public, anon, authenticated;
revoke all on function private.guard_role_capability() from public, anon, authenticated;
revoke all on function private.guard_user_capability_grant() from public, anon, authenticated;
revoke all on function private.guard_record_grant() from public, anon, authenticated;
revoke all on function private.guard_delegation() from public, anon, authenticated;

grant execute on function private.my_membership_ids() to authenticated, service_role;
grant execute on function private.my_org_ids() to authenticated, service_role;
grant execute on function private.is_member(uuid) to authenticated, service_role;
grant execute on function private.visible_person_ids() to authenticated, service_role;
grant execute on function private.is_assigned_to_scope(uuid, uuid) to authenticated, service_role;
grant execute on function private.capability_reach(uuid, text) to authenticated, service_role;
grant execute on function private.has_capability(uuid, text, uuid) to authenticated, service_role;
grant execute on function private.orgs_with_capability(text) to authenticated, service_role;
grant execute on function private.plan_limit(uuid, app.plan_limit_code) to service_role;
grant execute on function private.org_has_feature(uuid, app.plan_feature_code) to service_role;
grant execute on function private.transition_subscription(uuid, app.subscription_state, app.subscription_state, text) to service_role;
