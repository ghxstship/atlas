-- 1623_opportunity_spend_authority.sql
--
-- Notification and access decisions (ADR 0022, 1620-1629), RRR-125; owner decision 23 of 2026-10-23 (ADR 0033). Spend
-- authority when publishing an opportunity applies only to orgs that have spend limits set, until the screen for setting
-- them ships. Publishing a Contractor, Crew or Staff opportunity needed an Approved requisition (0774), and approving a
-- requisition needs a spend limit that covers it (0320: no limit refuses), so an org that had set none could never
-- publish one.
--   * private.org_sets_spend_limits(org, document type): whether the org has a live spend limit for the document type.
--     Publishing reads it for Requisition, the document spend authority runs on before an opportunity is published
--     (0360); a limit for purchase orders or expenses alone says nothing about staffing.
--   * private.guard_opportunity (from 1125, its latest definition): with a requisition limit, nothing changes. Without
--     one, a Contractor, Crew or Staff opportunity publishes without a requisition, and a named requisition only has to
--     be for the opportunity's project and role. Everything else the guard checks is unchanged.

create or replace function private.org_sets_spend_limits(p_org_id uuid, p_document_type app.spend_document_type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.spend_authorities sa
    where sa.org_id = p_org_id and sa.document_type = p_document_type and sa.deleted_at is null
      and sa.valid_from <= now() and (sa.valid_to is null or sa.valid_to > now()));
$$;

comment on function private.org_sets_spend_limits(uuid, app.spend_document_type) is 'Whether the org has a live spend limit (app.spend_authorities) for the document type, for any role or person. Publishing an opportunity requires an Approved requisition only when the org has one for Requisition (owner decision 23, 1623).';
revoke all on function private.org_sets_spend_limits(uuid, app.spend_document_type) from public, anon, authenticated;

create or replace function private.guard_opportunity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jurisdiction text;
  v_spend_limits boolean;
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.role_type <> old.role_type) then
    perform private.refuse('opportunity_immutable', 'An opportunity keeps its project and role type.');
  end if;
  if tg_op = 'UPDATE' and old.opportunity_state not in ('Draft', 'Pending Approval') and new.opportunity_state = old.opportunity_state
     and (new.pay_min_minor is distinct from old.pay_min_minor or new.pay_max_minor is distinct from old.pay_max_minor
          or new.rate_type is distinct from old.rate_type or new.currency_code is distinct from old.currency_code
          or new.visibility <> old.visibility or new.deadline_at is distinct from old.deadline_at
          or new.requisition_id is distinct from old.requisition_id or new.is_remote <> old.is_remote) then
    perform private.refuse('opportunity_published_terms', 'Compensation, visibility, deadline and requisition are fixed once published; pause, close and post a new opportunity.');
  end if;
  if new.opportunity_state = 'Published' and (tg_op = 'INSERT' or old.opportunity_state <> 'Published') then
    select coalesce(new.jurisdiction_id, v.jurisdiction_id, p.jurisdiction_id) into v_jurisdiction
    from app.projects p left join app.venues v on v.id = coalesce(new.venue_id, p.venue_id)
    where p.id = new.project_id;
    if v_jurisdiction is null then
      perform private.refuse('opportunity_jurisdiction_unknown', 'An opportunity needs a known jurisdiction before it is published, so pay transparency can be checked.');
    end if;
    -- Spend authority before publishing applies only where the org sets spend limits for requisitions (owner decision
    -- 23, 1623): without one, no requisition can be approved, so none is required, and a named one only has to match.
    v_spend_limits := private.org_sets_spend_limits(new.org_id, 'Requisition');
    if v_spend_limits and new.role_type in ('Contractor', 'Crew', 'Staff') and new.requisition_id is null then
      perform private.refuse('requisition_required', 'Your organization sets spend limits for requisitions: publish Contractor, Crew and Staff opportunities from an Approved requisition.');
    end if;
    if new.requisition_id is not null and v_spend_limits then
      perform private.assert_requisition_approved(new.requisition_id, new.project_id, new.role_code);
    elsif new.requisition_id is not null and exists (
      select 1 from app.requisitions r
      where r.id = new.requisition_id and (r.project_id <> new.project_id or (new.role_code is not null and r.role_code <> new.role_code))) then
      perform private.refuse('requisition_mismatch', 'The requisition is for another project or role.');
    end if;
    if new.role_type in ('Contractor', 'Crew', 'Staff') and private.pay_range_required(v_jurisdiction, new.is_remote)
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

comment on function private.guard_opportunity() is 'Opportunities: project and role type fixed; compensation, visibility, deadline, remote work and requisition fixed once published; publishing refuses an unknown jurisdiction, a Contractor, Crew or Staff posting without an Approved requisition for its project and role where the org sets spend limits for requisitions (1623), a named requisition that is not Approved there or is for another project or role anywhere, a missing pay range where a pay transparency rule in force covers the jurisdiction or the remote role (1125), Public visibility below the Pro plan, a bid opportunity without a deadline and a removed listing.';
revoke all on function private.guard_opportunity() from public, anon, authenticated;
