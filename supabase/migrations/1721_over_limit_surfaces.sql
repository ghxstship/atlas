-- 1721_over_limit_surfaces.sql
-- A107 (RRR-152), S16-07, Section 16: what Atlas shows of the read-only objects of 1720, and the Owner's choice of what
-- stays writable (ADR 0060).
--   * app.plan_limit_usage: for each object limit, the plan in force, the limit, how many objects it counts and how
--     many are read-only. Members; Atlas explains the limit on the pages it affects from it.
--   * app.plan_limit_candidates: the objects one limit counts, in the order of the selection rule, with their names
--     and whether each is chosen, locked writable (an Owner's seat) or read-only. The Owner's panel in Settings,
--     Billing and Plan lists them. Billing readers (org.billing.read).
--   * app.choose_plan_limit_keeps: the Owner (org.billing.manage) replaces what stays writable for one limit, at most
--     the limit less the Owners' seats, and the read-only objects are recomputed at once. Choosing changes no plan
--     and no payment, so it asks for no step-up.
--   * app.org_banner_status, the one call behind every org banner (1353, 1355), also returns the plan whose limits
--     the org exceeds, how many projects, seats and field seats are read-only, and whether the caller's own seat is.

create or replace function app.plan_limit_usage(p_org_id uuid)
returns table (limit_code text, plan_code text, limit_value bigint, in_use bigint, read_only bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'plan limit usage needs an active membership in the org';
  end if;
  return query
    with counted as (
      select c.limit_code, count(*) as n from private.over_limit_candidates(p_org_id) c group by c.limit_code
    ), held as (
      select x.limit_code, count(*) as n from app.over_limit_objects x where x.org_id = p_org_id group by x.limit_code
    )
    select l.limit_code::text, l.plan_code, l.limit_value, coalesce(c.n, 0), coalesce(h.n, 0)
    from private.org_plan_limits l
    left join counted c on c.limit_code = l.limit_code
    left join held h on h.limit_code = l.limit_code
    where l.org_id = p_org_id and l.limit_code in ('active_projects', 'seats', 'field_members')
    order by array_position(array['active_projects', 'seats', 'field_members']::app.plan_limit_code[], l.limit_code);
end;
$$;

comment on function app.plan_limit_usage(uuid) is 'For each limit that counts standing objects (active_projects, seats, field_members): the plan in force, the limit (null when unlimited), how many objects the org has and how many are read-only because they are past the limit (Section 16, ADR 0060). Members only.';
revoke all on function app.plan_limit_usage(uuid) from public, anon;
grant execute on function app.plan_limit_usage(uuid) to authenticated, service_role;

create or replace function app.plan_limit_candidates(p_org_id uuid, p_limit app.plan_limit_code)
returns table (
  project_id uuid,
  membership_id uuid,
  label text,
  project_key text,
  role_code text,
  role_name text,
  created_at timestamptz,
  chosen boolean,
  locked boolean,
  read_only boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.billing.read') then
    raise exception using errcode = '42501', message = 'org.billing.read is required';
  end if;
  return query
    select r.project_id, r.membership_id, coalesce(p.name, pe.full_name), p.project_key,
      case when br.org_id is null then br.code end, br.name, r.created_at, r.chosen, r.locked, r.read_only
    from private.over_limit_ranking(p_org_id) r
    left join app.projects p on p.id = r.project_id
    left join app.memberships m on m.id = r.membership_id
    left join app.people pe on pe.id = m.person_id
    left join lateral (
      select ro.org_id, ro.code, ro.name from app.membership_roles mr
      join app.roles ro on ro.id = mr.role_id and ro.deleted_at is null
      where mr.membership_id = r.membership_id and mr.deleted_at is null
      order by ro.band, ro.org_id nulls first, ro.code
      limit 1
    ) br on r.membership_id is not null
    where r.limit_code = p_limit
    order by r.rank;
end;
$$;

comment on function app.plan_limit_candidates(uuid, app.plan_limit_code) is 'The objects one object limit counts, in the order of the selection rule of ADR 0060 (Owners'' seats, then the Owner''s choice, then the oldest): the project''s name and key, or the member''s name and best role (a system role''s code, or a custom role''s name), with whether each is chosen, locked writable (an Owner''s seat) or read-only. Billing readers (org.billing.read).';
revoke all on function app.plan_limit_candidates(uuid, app.plan_limit_code) from public, anon;
grant execute on function app.plan_limit_candidates(uuid, app.plan_limit_code) to authenticated, service_role;

create or replace function app.choose_plan_limit_keeps(p_org_id uuid, p_limit app.plan_limit_code, p_keep uuid[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_keep uuid[] := array(select distinct k from unnest(coalesce(p_keep, '{}'::uuid[])) as k where k is not null);
  v_limit bigint;
  v_locked bigint;
  v_room bigint;
  v_plan text;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  if p_limit is null or p_limit not in ('active_projects', 'seats', 'field_members') then
    perform private.refuse('plan_limit_choice_limit', 'Choose what stays writable for active projects, seats or field seats.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('over-limit:' || p_org_id::text, 0));
  select l.limit_value, initcap(l.plan_code) into v_limit, v_plan
  from private.org_plan_limits l where l.org_id = p_org_id and l.limit_code = p_limit;
  if exists (select 1 from unnest(v_keep) as k
             where not exists (select 1 from private.over_limit_candidates(p_org_id) c
                               where c.limit_code = p_limit and not c.locked and coalesce(c.project_id, c.membership_id) = k)) then
    perform private.refuse('plan_limit_choice_unknown', case p_limit
      when 'active_projects' then 'Choose among the organization''s active projects.'
      when 'seats' then 'Choose among the members who hold a seat. Owners always keep theirs.'
      else 'Choose among the members who hold a field seat.' end);
  end if;
  select count(*) into v_locked from private.over_limit_candidates(p_org_id) c where c.limit_code = p_limit and c.locked;
  v_room := greatest(v_limit - v_locked, 0);
  if v_limit is not null and cardinality(v_keep) > v_room then
    perform private.refuse('plan_limit_choice_too_many', format(
      'The %s plan allows %s here%s, so choose at most %s to keep writable.', v_plan, v_limit,
      case when v_locked > 0 then format(' and Owners hold %s', v_locked) else '' end, v_room));
  end if;

  update app.plan_limit_choices set deleted_at = now()
  where org_id = p_org_id and limit_code = p_limit and deleted_at is null
    and not (coalesce(project_id, membership_id) = any (v_keep));
  insert into app.plan_limit_choices (org_id, limit_code, project_id, membership_id)
  select p_org_id, p_limit,
    case when p_limit = 'active_projects' then k end,
    case when p_limit <> 'active_projects' then k end
  from unnest(v_keep) as k
  where not exists (select 1 from app.plan_limit_choices c
                    where c.org_id = p_org_id and c.limit_code = p_limit and c.deleted_at is null
                      and coalesce(c.project_id, c.membership_id) = k);
  perform private.recompute_over_limit(p_org_id);
  return (select count(*)::integer from app.over_limit_objects x where x.org_id = p_org_id and x.limit_code = p_limit);
end;
$$;

comment on function app.choose_plan_limit_keeps(uuid, app.plan_limit_code, uuid[]) is 'The Owner (org.billing.manage) chooses what stays writable for one object limit (ADR 0060): projects for active_projects, members for seats or field_members, replacing the earlier choice for that limit. At most the limit less the seats Owners hold, among the objects the limit counts; Owners'' seats are always writable and are not chosen. The read-only objects are recomputed at once. Returns how many objects of the limit are read-only afterwards. Refusals: plan_limit_choice_limit, plan_limit_choice_unknown, plan_limit_choice_too_many.';
revoke all on function app.choose_plan_limit_keeps(uuid, app.plan_limit_code, uuid[]) from public, anon;
grant execute on function app.choose_plan_limit_keeps(uuid, app.plan_limit_code, uuid[]) to authenticated, service_role;

-- The org banners --------------------------------------------------------------------------------------------------

drop function app.org_banner_status(uuid);

create function app.org_banner_status(p_org_id uuid)
returns table (
  read_only_reason text,
  read_only_until timestamptz,
  purge_after timestamptz,
  recover_until timestamptz,
  trial_plan text,
  trial_ends_at timestamptz,
  billing_state text,
  past_due_since timestamptz,
  white_label_until timestamptz,
  ownership_transfer_id uuid,
  ownership_offered_by text,
  ownership_expires_at timestamptz,
  over_limit_plan text,
  read_only_projects integer,
  read_only_seats integer,
  read_only_field_seats integer,
  own_seat_read_only text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_sub app.subscriptions;
  v_staff boolean;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'banner status needs an active membership in the org';
  end if;
  v_reason := private.org_read_only_reason(p_org_id);
  v_staff := private.has_capability(p_org_id, 'org.settings.read');
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
  return query select
    v_reason,
    (select c.read_only_until from app.org_cancellations c where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null limit 1),
    (select c.purge_after from app.org_cancellations c where c.org_id = p_org_id and c.reactivated_at is null and c.deleted_at is null limit 1),
    (select r.recover_until from app.org_deletion_requests r where r.org_id = p_org_id and r.recovered_at is null and r.deleted_at is null limit 1),
    case when v_sub.subscription_state = 'trialing' then v_sub.plan_code end,
    case when v_sub.subscription_state = 'trialing' then v_sub.trial_ends_at end,
    case when v_sub.subscription_state in ('past_due', 'read_only') and (v_staff or v_sub.subscription_state = 'read_only')
         then v_sub.subscription_state::text end,
    case when v_sub.subscription_state in ('past_due', 'read_only') and (v_staff or v_sub.subscription_state = 'read_only')
         then private.past_due_since(v_sub.id) end,
    case when v_staff then (select g.kept_until from app.white_label_grace g
                            where g.org_id = p_org_id and g.ended_at is null and g.deleted_at is null and g.kept_until > now()
                            limit 1) end,
    o.id, o.offered_by, o.expires_at,
    x.plan_code, coalesce(x.projects, 0), coalesce(x.seats, 0), coalesce(x.field_seats, 0),
    (select ox.limit_code::text from app.over_limit_objects ox
     join app.memberships m on m.id = ox.membership_id
     where ox.org_id = p_org_id and m.person_id = private.current_person_id()
     order by ox.limit_code limit 1)
  from (select 1) one
  left join lateral (
    select t.id, p.full_name as offered_by, t.expires_at from app.ownership_transfers t
    join app.people p on p.id = t.from_person_id
    where t.org_id = p_org_id and t.to_person_id = private.current_person_id()
      and t.accepted_at is null and t.declined_at is null and t.canceled_at is null and t.expired_at is null
      and t.deleted_at is null and t.expires_at > now()
    limit 1
  ) o on true
  left join lateral (
    select min(ox.plan_code) as plan_code,
      (count(*) filter (where ox.limit_code = 'active_projects'))::integer as projects,
      (count(*) filter (where ox.limit_code = 'seats'))::integer as seats,
      (count(*) filter (where ox.limit_code = 'field_members'))::integer as field_seats
    from app.over_limit_objects ox where ox.org_id = p_org_id
    having count(*) > 0
  ) x on true;
end;
$$;

comment on function app.org_banner_status(uuid) is 'Everything the org banners show, in one call, for an active member: why the org is read-only with its dates (cancellation, deletion request, dunning), the running trial and its end, the dunning state and when the payment first failed (Owners and Admins from day 0, everyone once the org is read-only), until when a downgraded org keeps its white label (1355), an ownership offer made to the caller (1352), and what plan limits made read-only (1721): the plan, how many projects, seats and field seats, and whether the caller''s own seat is read-only (seats or field_members).';
revoke all on function app.org_banner_status(uuid) from public, anon;
grant execute on function app.org_banner_status(uuid) to authenticated, service_role;
