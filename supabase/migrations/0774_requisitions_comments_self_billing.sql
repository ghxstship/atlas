-- 0774_requisitions_comments_self_billing.sql
-- A28 Engagements and Marketplace (RRR-30). Three carry-overs now that their owners have merged:
--   * Spend authority before publishing (ADR 0019 open decision, Section 4.4.3): opportunities.requisition_id links
--     an opportunity to A03's staffing requisition (0361). Contractor, Crew and Staff opportunities publish only from an
--     Approved requisition for the same project and role, checked by private.assert_requisition_approved inside the
--     publishing guard; any other opportunity that names a requisition must name an Approved one too
--   * Comments and attachments (0580, 0590): the engagement and marketplace tables become comment subjects. 0580 runs
--     before 0700, so its own list skipped them
--   * Self-billing consent (Section 4.4.5): app.self_billing_agreements records the party's agreement, per engagement,
--     that the org may generate its invoices from approved timesheets; A15 owns the generation and the org setting

-- Requisitions --------------------------------------------------------------------------------------------------------

alter table app.opportunities add column requisition_id uuid references app.requisitions (id);
create index opportunities_requisition_id_idx on app.opportunities (requisition_id);
comment on column app.opportunities.requisition_id is 'Approved requisition the opportunity is published from (Section 4.4.3, spend authority before publishing). Required to publish Contractor, Crew and Staff opportunities; fixed once published.';

call private.install_tenant_guards('app.opportunities', 'app.projects', 'project_id',
  array['app.scope_nodes', 'scope_node_id', 'app.venues', 'venue_id', 'app.requisitions', 'requisition_id']);

grant insert (requisition_id), update (requisition_id) on app.opportunities to authenticated;

create or replace function private.guard_opportunity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jurisdiction text;
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.role_type <> old.role_type) then
    perform private.refuse('opportunity_immutable', 'An opportunity keeps its project and role type.');
  end if;
  if tg_op = 'UPDATE' and old.opportunity_state not in ('Draft', 'Pending Approval') and new.opportunity_state = old.opportunity_state
     and (new.pay_min_minor is distinct from old.pay_min_minor or new.pay_max_minor is distinct from old.pay_max_minor
          or new.rate_type is distinct from old.rate_type or new.currency_code is distinct from old.currency_code
          or new.visibility <> old.visibility or new.deadline_at is distinct from old.deadline_at
          or new.requisition_id is distinct from old.requisition_id) then
    perform private.refuse('opportunity_published_terms', 'Compensation, visibility, deadline and requisition are fixed once published; pause, close and post a new opportunity.');
  end if;
  if new.opportunity_state = 'Published' and (tg_op = 'INSERT' or old.opportunity_state <> 'Published') then
    select coalesce(new.jurisdiction_id, v.jurisdiction_id, p.jurisdiction_id) into v_jurisdiction
    from app.projects p left join app.venues v on v.id = coalesce(new.venue_id, p.venue_id)
    where p.id = new.project_id;
    if v_jurisdiction is null then
      perform private.refuse('opportunity_jurisdiction_unknown', 'An opportunity needs a known jurisdiction before it is published, so pay transparency can be checked.');
    end if;
    if new.role_type in ('Contractor', 'Crew', 'Staff') and new.requisition_id is null then
      perform private.refuse('requisition_required', 'Publish Contractor, Crew and Staff opportunities from an Approved requisition.');
    end if;
    if new.requisition_id is not null then
      perform private.assert_requisition_approved(new.requisition_id, new.project_id, new.role_code);
    end if;
    if new.role_type in ('Contractor', 'Crew', 'Staff') and private.pay_range_required(v_jurisdiction)
       and (new.pay_min_minor is null or new.pay_max_minor is null) then
      perform private.refuse('pay_range_required', format('A pay range is required to publish work in %s.', v_jurisdiction));
    end if;
    if new.visibility = 'Public' and not private.org_has_feature(new.org_id, 'public_marketplace_listings') then
      perform private.refuse('plan_feature_unavailable', 'Public marketplace listings need the Pro plan or above.');
    end if;
    if new.rate_type = 'Bid' and new.deadline_at is null then
      perform private.refuse('bid_deadline_required', 'A bid opportunity needs a deadline; bids stay sealed until it passes.');
    end if;
    if private.opportunity_removed(new.id) then
      perform private.refuse('opportunity_removed', 'A removed listing cannot be published until moderation restores it.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_opportunity() is 'Opportunities: project and role type fixed; compensation, visibility, deadline and requisition fixed once published; publishing refuses an unknown jurisdiction, a Contractor, Crew or Staff posting without an Approved requisition for its project and role (spend authority before publishing), any other named requisition that is not Approved, a missing pay range where a pay transparency rule requires one, Public visibility below the Pro plan, a bid opportunity without a deadline and a removed listing.';

-- Comment subjects -----------------------------------------------------------------------------------------------------------

insert into private.comment_subjects (table_name) values
  ('app.engagements'), ('app.engagement_documents'), ('app.opportunities'), ('app.applications'), ('app.offers'),
  ('app.talent_pools'), ('app.onboarding_items'), ('app.engagement_deliverables'), ('app.client_approval_requests')
on conflict (table_name) do nothing;

-- Self-billing consent ------------------------------------------------------------------------------------------------------------

create table app.self_billing_agreements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  agreed_by uuid references app.people (id),
  agreed_at timestamptz not null default now(),
  revoked_by uuid references app.people (id),
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint self_billing_agreements_revoke_pair check ((revoked_at is null) = (revoked_by is null))
);

create unique index self_billing_agreements_live_key on app.self_billing_agreements (engagement_id) where revoked_at is null and deleted_at is null;
create index self_billing_agreements_agreed_by_idx on app.self_billing_agreements (agreed_by);
create index self_billing_agreements_revoked_by_idx on app.self_billing_agreements (revoked_by);

call private.install_domain_table('app.self_billing_agreements', 'app.engagements', 'engagement_id');
call private.describe('app.self_billing_agreements', 'The engaged party''s consent, per engagement, that the org generates its invoices from approved timesheets (Section 4.4.5 self-billing). Generation also needs the org''s own setting and belongs to A15; only the party agrees or revokes, and a revoked agreement stays as evidence.', array[
  'engagement_id', 'Engagement the consent covers.',
  'agreed_by', 'Party person who agreed, set from the session.',
  'agreed_at', 'When agreed, set by the database.',
  'revoked_by', 'Party person who revoked, set from the session.',
  'revoked_at', 'When revoked; invoices are no longer generated from then on.'
]);

call private.install_policies('app.self_billing_agreements',
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))$$);
revoke insert, update on app.self_billing_agreements from authenticated;

create or replace function private.self_billing_party_open(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    left join app.counterparties c on c.id = e.counterparty_id
    where e.id = p_engagement_id and e.deleted_at is null
      and ((e.counterparty_id is null and e.person_id = private.current_person_id())
        or c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'money'));
$$;

comment on function private.self_billing_party_open(uuid) is 'Section 8.7: true when the signed-in person consents for the party that is billed: the engaged person when no account bills, or the billing account''s Owner, Admin or Finance member, while the money area is open.';

create or replace function app.agree_self_billing(p_engagement_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_person();
  if not private.self_billing_party_open(p_engagement_id) then
    raise exception using errcode = '42501', message = 'only the billed party agrees to self-billing';
  end if;
  if exists (select 1 from app.self_billing_agreements a where a.engagement_id = p_engagement_id and a.revoked_at is null and a.deleted_at is null) then
    perform private.refuse('self_billing_already_agreed', 'Self-billing is already agreed for this engagement.');
  end if;
  insert into app.self_billing_agreements (engagement_id, agreed_by, agreed_at)
  values (p_engagement_id, private.current_person_id(), now()) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.agree_self_billing(uuid) is 'The billed party agrees that the org may generate its invoices from approved timesheets on this engagement. Returns the agreement id.';

create or replace function app.revoke_self_billing(p_engagement_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.self_billing_party_open(p_engagement_id) then
    raise exception using errcode = '42501', message = 'only the billed party revokes self-billing';
  end if;
  update app.self_billing_agreements set revoked_at = now(), revoked_by = private.current_person_id()
  where engagement_id = p_engagement_id and revoked_at is null and deleted_at is null;
  if not found then
    perform private.refuse('self_billing_not_agreed', 'There is no self-billing agreement to revoke on this engagement.');
  end if;
end;
$$;

comment on function app.revoke_self_billing(uuid) is 'The billed party withdraws self-billing consent on the engagement; invoices already generated stay.';

create view api_external.self_billing_agreements as
select a.id, a.engagement_id, a.agreed_at, a.revoked_at, (a.revoked_at is null) as is_active
from app.self_billing_agreements a
where a.deleted_at is null and private.self_billing_party_open(a.engagement_id);

call private.describe('api_external.self_billing_agreements', 'Self-billing consents of the caller''s billed engagements, active and revoked.', array[
  'id', 'Agreement.', 'engagement_id', 'Engagement.', 'agreed_at', 'When agreed.', 'revoked_at', 'When revoked.', 'is_active', 'True while in force.']);

-- Retention, audit and privileges -----------------------------------------------------------------------------------------------------

call private.install_default_retention('app.self_billing_agreements');
call private.install_audit_trail('app.self_billing_agreements');

revoke all on function private.self_billing_party_open(uuid) from public, anon;
grant execute on function private.self_billing_party_open(uuid) to authenticated, service_role;
revoke all on function app.agree_self_billing(uuid) from public, anon;
revoke all on function app.revoke_self_billing(uuid) from public, anon;
grant execute on function app.agree_self_billing(uuid) to authenticated, service_role;
grant execute on function app.revoke_self_billing(uuid) to authenticated, service_role;

revoke all on api_external.self_billing_agreements from public, anon;
grant select on api_external.self_billing_agreements to authenticated, service_role;
