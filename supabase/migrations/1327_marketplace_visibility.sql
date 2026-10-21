-- 1327_marketplace_visibility.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): gateway.marketplace_visibility (Section 4.5.6 item 27, "who can
-- find the organization in the Gateway marketplace") caps how widely the org's opportunities reach.
--
--   public   opportunities may be Public (with the plan feature), Network, Pool or Invited
--   network  (default) up to Network: anyone with a completed engagement with the org, pools and invitees
--   private  only pools and invitees
--
-- Publishing an opportunity wider than the cap is refused (opportunity_visibility_above_org), and the cap also
-- applies when listings are read, so lowering it hides wider listings already published. Invitations still reach
-- the people named at every level. gateway.ratings_enabled stays as it is: turning ratings off needs an owner and
-- counsel decision (Section 14.9).

create or replace function private.marketplace_visibility_rank(p_visibility app.opportunity_visibility)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_visibility when 'Public' then 2 when 'Network' then 1 else 0 end;
$$;

comment on function private.marketplace_visibility_rank(app.opportunity_visibility) is 'How widely an opportunity visibility reaches: 0 for Invited and Pool, 1 for Network, 2 for Public.';
revoke all on function private.marketplace_visibility_rank(app.opportunity_visibility) from public, anon, authenticated;

create or replace function private.marketplace_visibility_cap(p_org_id uuid, p_visibility app.opportunity_visibility)
returns app.opportunity_visibility
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.marketplace_visibility_rank(p_visibility) <= v.cap then p_visibility
    when v.cap = 1 then 'Network'::app.opportunity_visibility
    else 'Invited'::app.opportunity_visibility
  end
  from (select case coalesce(private.setting_text(p_org_id, 'gateway.marketplace_visibility'), 'network')
    when 'public' then 2 when 'network' then 1 else 0 end as cap) v;
$$;

comment on function private.marketplace_visibility_cap(uuid, app.opportunity_visibility) is 'An opportunity''s visibility as the org''s gateway.marketplace_visibility allows it (1327): unchanged when within the setting, otherwise Network (network) or Invited (private).';
revoke all on function private.marketplace_visibility_cap(uuid, app.opportunity_visibility) from public, anon, authenticated;

create or replace function private.guard_opportunity_marketplace_visibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.opportunity_state = 'Published' and (tg_op = 'INSERT' or old.opportunity_state <> 'Published')
     and private.marketplace_visibility_cap(new.org_id, new.visibility) <> new.visibility then
    perform private.refuse('opportunity_visibility_above_org',
      format('Your organization''s marketplace visibility is %s; publish to a narrower audience or change it in Settings.',
        coalesce(private.setting_text(new.org_id, 'gateway.marketplace_visibility'), 'network')));
  end if;
  return new;
end;
$$;

comment on function private.guard_opportunity_marketplace_visibility() is 'Refuses publishing an opportunity wider than the org''s gateway.marketplace_visibility (1327).';
revoke all on function private.guard_opportunity_marketplace_visibility() from public, anon, authenticated;

create trigger t45_guard_opportunity_marketplace_visibility before insert or update on app.opportunities
  for each row execute function private.guard_opportunity_marketplace_visibility();

-- Read-time cap: 0720's visibility rule with the org's setting applied.

create or replace function private.opportunity_open_to_person(
  p_opportunity_id uuid,
  p_org_id uuid,
  p_visibility app.opportunity_visibility,
  p_state app.opportunity_state,
  p_person_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_visibility app.opportunity_visibility := private.marketplace_visibility_cap(p_org_id, p_visibility);
begin
  if p_person_id is null or p_state <> 'Published' or private.opportunity_removed(p_opportunity_id)
     or private.excluded_from_org(p_org_id, p_person_id) then
    return false;
  end if;
  if v_visibility = 'Public' then
    return true;
  end if;
  if exists (
    select 1 from app.opportunity_invitations i
    where i.opportunity_id = p_opportunity_id and i.deleted_at is null
      and (i.person_id = p_person_id or i.organization_id in (select private.person_account_ids(p_person_id)))) then
    return true;
  end if;
  if v_visibility = 'Pool' and exists (
    select 1 from app.pool_members pm
    where pm.org_id = p_org_id and pm.deleted_at is null and pm.standing in ('Preferred', 'Approved')
      and (pm.person_id = p_person_id or pm.organization_id in (select private.person_account_ids(p_person_id)))) then
    return true;
  end if;
  if v_visibility = 'Network' and exists (
    select 1 from app.engagements e left join app.counterparties c on c.id = e.counterparty_id
    where e.org_id = p_org_id and e.deleted_at is null and e.engagement_state = 'Complete'
      and (e.person_id = p_person_id or c.organization_id in (select private.person_account_ids(p_person_id)))) then
    return true;
  end if;
  return false;
end;
$$;

comment on function private.opportunity_open_to_person(uuid, uuid, app.opportunity_visibility, app.opportunity_state, uuid) is 'Section 4.4.3 visibility for a person: Published, not removed by moderation, not withheld by a Do Not Engage flag on the person or an account they belong to, and Public, or invited by name (the person or one of their accounts, at any visibility level), or in a pool of the org for Pool, or with a completed engagement with the org for Network. The org''s gateway.marketplace_visibility caps the visibility at read time (1327), so turning it down hides listings at once. Takes the opportunity''s column values.';

