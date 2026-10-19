-- 1202_access_reviews.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Section 8.4: "each quarter, managers confirm or remove each member's
-- role. Access left unreviewed after 14 days is flagged, and is removed automatically if the org turns that on." Section
-- 4.5.6 item 11 is the Access Reviews settings page and Section 7.3 names access_review_campaigns and access_review_items.
-- A50 retired both resources because nothing stored or enforced a review.
--   * app.access_review_campaigns: a campaign opens Active and snapshots one item per live role assignment
--     (app.membership_roles) of every active membership in the org. One Active campaign per org at a time. A campaign
--     completes when every item is decided; deleting an Active campaign cancels it and leaves its roles untouched.
--   * app.access_review_items: a reviewer (org.access_reviews.manage) records Confirmed or Removed once. Removed ends the
--     role assignment at once through the membership guard, so the sole Owner can never be removed. A reviewer never
--     decides their own access (Section 8.2: separation of duties is checked against the person) nor a role above their
--     own band.
--   * Unreviewed items are flagged once the campaign has been open longer than access_reviews.grace_days (default 14).
--     When the campaign's auto_remove_unreviewed is on (it starts from the org setting access_reviews.remove_unreviewed),
--     flagged roles are removed and the item records the automatic removal. A nightly job runs the sweep; an item whose
--     removal the guards refuse (the sole Owner) stays flagged.

create table app.access_review_campaigns (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  due_on date not null,
  auto_remove_unreviewed boolean not null default false,
  campaign_state text not null default 'Active',
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  deleted_at timestamptz,
  constraint access_review_campaigns_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint access_review_campaigns_state check (campaign_state in ('Active', 'Complete', 'Canceled')),
  constraint access_review_campaigns_closed check ((campaign_state = 'Active') = (closed_at is null))
);

create unique index access_review_campaigns_one_active_key on app.access_review_campaigns (org_id)
  where campaign_state = 'Active' and deleted_at is null;

call private.install_domain_table('app.access_review_campaigns');
call private.describe('app.access_review_campaigns', 'Access review campaigns (Section 8.4): reviewers confirm or remove each member''s role. One Active campaign per org; it completes when every item is decided, and deleting an Active campaign cancels it.', array[
  'name', 'Campaign name, for example Q4 Access Review.',
  'due_on', 'Date reviewers are asked to finish by.',
  'auto_remove_unreviewed', 'When true, roles still unreviewed after access_reviews.grace_days are removed automatically. Starts from the org setting access_reviews.remove_unreviewed.',
  'campaign_state', 'Active, Complete (every item decided) or Canceled (deleted while Active). Set by the database.',
  'opened_at', 'When the campaign opened and its items were taken; the grace period counts from here.',
  'closed_at', 'When the campaign completed or was canceled; NULL while Active.'
]);

call private.install_policies('app.access_review_campaigns',
  $$org_id in (select private.orgs_with_capability('org.members.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.access_reviews.manage'))$$);

revoke insert, update on app.access_review_campaigns from authenticated;
grant insert (org_id, name, due_on, auto_remove_unreviewed) on app.access_review_campaigns to authenticated;
grant update (name, due_on, auto_remove_unreviewed, deleted_at) on app.access_review_campaigns to authenticated;

call private.install_default_retention('app.access_review_campaigns');
call private.install_audit_trail('app.access_review_campaigns');

create table app.access_review_items (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  access_review_campaign_id uuid not null references app.access_review_campaigns (id),
  membership_role_id uuid not null references app.membership_roles (id),
  decision text,
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  flagged_at timestamptz,
  deleted_at timestamptz,
  constraint access_review_items_decision check (decision is null or decision in ('Confirmed', 'Removed')),
  constraint access_review_items_decided check ((decision is null) = (decided_at is null)),
  constraint access_review_items_decider check (decided_by is null or decision is not null)
);

create unique index access_review_items_campaign_role_key on app.access_review_items (access_review_campaign_id, membership_role_id);
create index access_review_items_membership_role_id_idx on app.access_review_items (membership_role_id);
create index access_review_items_decided_by_idx on app.access_review_items (decided_by);
create index access_review_items_open_idx on app.access_review_items (access_review_campaign_id) where decision is null;

call private.install_domain_table('app.access_review_items', 'app.access_review_campaigns', 'access_review_campaign_id',
  array['app.membership_roles', 'membership_role_id']);
call private.describe('app.access_review_items', 'One role assignment to confirm or remove in an access review campaign (Section 8.4). Taken when the campaign opens; decided once. Removed ends the role at once.', array[
  'access_review_campaign_id', 'Campaign the item belongs to.',
  'membership_role_id', 'Role assignment under review.',
  'decision', 'Confirmed or Removed; NULL while unreviewed. Final once set.',
  'decided_by', 'Reviewer, from the session; NULL for an automatic removal of unreviewed access.',
  'decided_at', 'When the decision was recorded.',
  'flagged_at', 'When the item was flagged as unreviewed after the grace period; NULL until then.'
]);

call private.install_policies('app.access_review_items',
  $$org_id in (select private.orgs_with_capability('org.members.read'))$$,
  null,
  $$org_id in (select private.orgs_with_capability('org.access_reviews.manage'))$$);

revoke update on app.access_review_items from authenticated;
grant update (decision) on app.access_review_items to authenticated;

call private.install_default_retention('app.access_review_items');
call private.install_audit_trail('app.access_review_items');

-- Campaign lifecycle -----------------------------------------------------------------------------------------------------

create or replace function private.guard_access_review_campaign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('access_review_close') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.campaign_state := 'Active';
    new.opened_at := now();
    new.closed_at := null;
    if new.due_on < (now() at time zone 'UTC')::date then
      perform private.refuse('access_review_due_past', 'Choose a due date from today on.');
    end if;
    return new;
  end if;
  if new.campaign_state is distinct from old.campaign_state or new.opened_at is distinct from old.opened_at
     or new.closed_at is distinct from old.closed_at then
    perform private.refuse('access_review_state', 'A campaign completes when every item is decided and is canceled by deleting it.');
  end if;
  if old.deleted_at is not null then
    perform private.refuse('access_review_deleted', 'A deleted campaign cannot change.');
  end if;
  if new.deleted_at is not null then
    if old.campaign_state = 'Active' then
      new.campaign_state := 'Canceled';
      new.closed_at := now();
    end if;
    return new;
  end if;
  if old.campaign_state <> 'Active' then
    perform private.refuse('access_review_closed', 'A completed or canceled campaign cannot change.');
  end if;
  return new;
end;
$$;

comment on function private.guard_access_review_campaign() is 'Access review campaigns open Active with today''s date; the state changes only by completing every item or by deleting an Active campaign, which cancels it; closed campaigns are read-only.';
revoke all on function private.guard_access_review_campaign() from public, anon, authenticated;

create trigger t40_guard_access_review_campaign before insert or update on app.access_review_campaigns
  for each row execute function private.guard_access_review_campaign();

create or replace function private.open_access_review_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.access_review_items (access_review_campaign_id, membership_role_id)
  select new.id, mr.id
  from app.membership_roles mr
  join app.memberships m on m.id = mr.membership_id
  where mr.org_id = new.org_id and mr.deleted_at is null
    and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  return null;
end;
$$;

comment on function private.open_access_review_items() is 'After a campaign is created: takes one item for every live role assignment of every active membership in the org.';
revoke all on function private.open_access_review_items() from public, anon, authenticated;

create trigger t80_open_access_review_items after insert on app.access_review_campaigns
  for each row execute function private.open_access_review_items();

create or replace function private.complete_access_review_if_done(p_campaign_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from app.access_review_items i
                 where i.access_review_campaign_id = p_campaign_id and i.decision is null and i.deleted_at is null) then
    perform private.begin_trusted_operation('access_review_close');
    update app.access_review_campaigns c set campaign_state = 'Complete', closed_at = now()
    where c.id = p_campaign_id and c.campaign_state = 'Active' and c.deleted_at is null;
    perform private.end_trusted_operation('access_review_close');
  end if;
end;
$$;

comment on function private.complete_access_review_if_done(uuid) is 'Completes an Active campaign once none of its items is unreviewed.';
revoke all on function private.complete_access_review_if_done(uuid) from public, anon, authenticated;

-- Decisions ----------------------------------------------------------------------------------------------------------------

create or replace function private.remove_reviewed_role(p_membership_role_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.begin_trusted_operation('membership_write');
  update app.membership_roles mr set deleted_at = now()
  where mr.id = p_membership_role_id and mr.deleted_at is null;
  perform private.end_trusted_operation('membership_write');
end;
$$;

comment on function private.remove_reviewed_role(uuid) is 'Ends a role assignment an access review removed. The membership guard still refuses removing the sole Owner (Section 7.5 invariant 4).';
revoke all on function private.remove_reviewed_role(uuid) from public, anon, authenticated;

create or replace function private.guard_access_review_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign app.access_review_campaigns;
  v_holder uuid;
  v_band smallint;
  v_me uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    new.decision := null;
    new.decided_by := null;
    new.decided_at := null;
    new.flagged_at := null;
    return new;
  end if;
  if private.in_trusted_operation('access_review_sweep') then
    return new;
  end if;
  if new.access_review_campaign_id <> old.access_review_campaign_id or new.membership_role_id <> old.membership_role_id then
    perform private.refuse('access_review_item_immutable', 'An item stays with its campaign and role.');
  end if;
  if new.decision is not distinct from old.decision then
    return new;
  end if;
  if old.decision is not null then
    perform private.refuse('access_review_decided', 'This access was already reviewed; the decision is final.');
  end if;
  select * into v_campaign from app.access_review_campaigns c where c.id = new.access_review_campaign_id;
  if v_campaign.campaign_state <> 'Active' or v_campaign.deleted_at is not null then
    perform private.refuse('access_review_closed', 'The campaign is no longer active.');
  end if;
  select m.person_id, r.band into v_holder, v_band
  from app.membership_roles mr
  join app.memberships m on m.id = mr.membership_id
  join app.roles r on r.id = mr.role_id
  where mr.id = new.membership_role_id;
  if v_me is not null then
    if v_holder = v_me then
      perform private.refuse('sod_self_review', 'A person cannot review their own access; another reviewer decides it.');
    end if;
    if coalesce(private.best_band(v_me, new.org_id), 8) > v_band then
      perform private.refuse('role_band', 'A reviewer can decide only roles at or below their own band.');
    end if;
  end if;
  new.decided_by := v_me;
  new.decided_at := now();
  if new.decision = 'Removed' then
    perform private.remove_reviewed_role(new.membership_role_id);
  end if;
  return new;
end;
$$;

comment on function private.guard_access_review_item() is 'Access review items: decided once, only in an Active campaign, never by the person who holds the role and never above the reviewer''s band (Section 8.2); Removed ends the role at once through the membership guard.';
revoke all on function private.guard_access_review_item() from public, anon, authenticated;

create trigger t40_guard_access_review_item before insert or update on app.access_review_items
  for each row execute function private.guard_access_review_item();

create or replace function private.after_access_review_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.complete_access_review_if_done(new.access_review_campaign_id);
  return null;
end;
$$;

comment on function private.after_access_review_decision() is 'After an item is decided: completes its campaign when nothing is left to review.';
revoke all on function private.after_access_review_decision() from public, anon, authenticated;

create trigger t80_complete_access_review after update of decision on app.access_review_items
  for each row when (new.decision is not null and old.decision is null)
  execute function private.after_access_review_decision();

-- Unreviewed access ------------------------------------------------------------------------------------------------------

create or replace function private.sweep_access_reviews()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_campaign record;
  v_item record;
  v_count integer := 0;
begin
  for v_campaign in
    select c.id, c.org_id, c.auto_remove_unreviewed
    from app.access_review_campaigns c
    where c.campaign_state = 'Active' and c.deleted_at is null
      and c.opened_at + make_interval(days => coalesce(
        (select v.value_integer::integer from app.setting_values v
         where v.org_id = c.org_id and v.setting_key = 'access_reviews.grace_days' and v.scope_kind = 'Organization'
           and v.scope_id = c.org_id and v.deleted_at is null),
        (select d.default_integer::integer from private.setting_definitions d where d.setting_key = 'access_reviews.grace_days'),
        14)) <= now()
  loop
    perform private.begin_trusted_operation('access_review_sweep');
    update app.access_review_items i set flagged_at = now()
    where i.access_review_campaign_id = v_campaign.id and i.decision is null and i.flagged_at is null and i.deleted_at is null;
    perform private.end_trusted_operation('access_review_sweep');

    if v_campaign.auto_remove_unreviewed then
      for v_item in
        select i.id, i.membership_role_id from app.access_review_items i
        where i.access_review_campaign_id = v_campaign.id and i.decision is null and i.deleted_at is null
      loop
        begin
          perform private.remove_reviewed_role(v_item.membership_role_id);
          perform private.begin_trusted_operation('access_review_sweep');
          update app.access_review_items i set decision = 'Removed', decided_at = now(), decided_by = null
          where i.id = v_item.id;
          perform private.end_trusted_operation('access_review_sweep');
          perform private.write_audit_event(v_campaign.org_id, 'access_review_items.removed_unreviewed', 'app.access_review_items',
            v_item.id, jsonb_build_object('membership_role_id', v_item.membership_role_id));
          v_count := v_count + 1;
        exception when sqlstate 'XR001' then
          -- The guards refused (the sole Owner): the item stays flagged for a reviewer.
          null;
        end;
      end loop;
      perform private.complete_access_review_if_done(v_campaign.id);
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function private.sweep_access_reviews() is 'Nightly: flags items still unreviewed once their campaign has been open longer than access_reviews.grace_days, and, for campaigns with auto_remove_unreviewed, removes those roles and records the automatic removal. A removal the guards refuse leaves the item flagged. Returns how many roles it removed.';
revoke all on function private.sweep_access_reviews() from public, anon, authenticated;

select cron.schedule('xos_nightly_access_review_sweep', '23 3 * * *', 'select private.sweep_access_reviews()');
