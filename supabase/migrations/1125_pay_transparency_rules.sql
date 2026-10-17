-- 1125_pay_transparency_rules.sql
-- A43 (RRR-87), finding A38-006: pay-transparency rules ship with the platform (Section 4.4.3, 14.9).
-- private.pay_transparency_rules (0720) was empty and keyed to canon jurisdictions, and canon holds no US state
-- below Florida, so no rule could be loaded. The table now:
--   * keys a rule by an ISO 3166-2 style jurisdiction code (US-CA), matched against an opportunity's canon
--     jurisdiction and every jurisdiction beneath it by code prefix (US-CA-LOS-ANGELES falls under US-CA), so a
--     rule applies as soon as canon adds the jurisdiction;
--   * may hold successive rules per jurisdiction by effective date;
--   * says whether the rule also covers remote roles (applies_to_remote): a remote posting is covered when any
--     rule in force in its country covers remote roles, because the role may be filled from there;
--   * marks rows the owner has not yet confirmed with counsel (needs_counsel_review).
-- app.opportunities gains is_remote. Publishing a Contractor, Crew or Staff opportunity without a pay range
-- where a rule in force requires one is refused with XR001 pay_range_required (private.guard_opportunity).
-- Seed: CA, CO, WA, NY, IL, MD, HI, MN, VT, MA, NJ and DC, every row needs_counsel_review = true. The owner
-- confirms the list, dates and remote coverage with counsel before relying on them.

alter table private.pay_transparency_rules
  drop constraint pay_transparency_rules_jurisdiction_id_fkey,
  drop constraint pay_transparency_rules_pkey,
  add column applies_to_remote boolean not null default false,
  add column needs_counsel_review boolean not null default true,
  add constraint pay_transparency_rules_pkey primary key (jurisdiction_id, effective_from),
  add constraint pay_transparency_rules_jurisdiction_format check (jurisdiction_id ~ '^[A-Z]{2}(-[A-Z0-9]+)*$');

comment on table private.pay_transparency_rules is 'Where a posted pay range is legally required (Section 4.4.3, Section 14.9). A rule covers its jurisdiction code and every jurisdiction beneath it by code prefix, from its effective date until a later rule for the same code. Rows are legal reference data maintained by the platform and confirmed with counsel.';
comment on column private.pay_transparency_rules.jurisdiction_id is 'ISO 3166-2 style jurisdiction code the rule covers (for example US-CA), with every canon jurisdiction beneath it.';
comment on column private.pay_transparency_rules.applies_to_remote is 'True when the rule also covers remote roles that may be filled from the jurisdiction.';
comment on column private.pay_transparency_rules.needs_counsel_review is 'True until the owner has confirmed the row with counsel; shown in the admin settings.';

create or replace view app.pay_transparency_rules as
select r.jurisdiction_id, r.requires_pay_range, r.effective_from, r.citation, r.applies_to_remote, r.needs_counsel_review
from private.pay_transparency_rules r;

call private.describe('app.pay_transparency_rules', 'Pay transparency rules by jurisdiction: where an opportunity cannot be published without a pay range.', array[
  'jurisdiction_id', 'Jurisdiction code covered, with those beneath it.',
  'requires_pay_range', 'True when a pay range is required.',
  'effective_from', 'First day the rule applies.',
  'citation', 'The law or regulation.',
  'applies_to_remote', 'True when remote roles fillable from the jurisdiction are covered.',
  'needs_counsel_review', 'True until the owner has confirmed the rule with counsel.']);

alter table app.opportunities add column is_remote boolean not null default false;
grant insert (is_remote), update (is_remote) on app.opportunities to authenticated;
comment on column app.opportunities.is_remote is 'True when the work can be done remotely; remote postings follow the pay transparency rules that cover remote roles.';

-- The rule in force for each code is the latest one effective today.
create or replace function private.pay_range_required(p_jurisdiction_id text, p_remote boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with in_force as (
    select distinct on (r.jurisdiction_id) r.*
    from private.pay_transparency_rules r
    where r.effective_from <= current_date
    order by r.jurisdiction_id, r.effective_from desc
  )
  select coalesce(bool_or(f.requires_pay_range), false)
  from in_force f
  where p_jurisdiction_id = f.jurisdiction_id
     or p_jurisdiction_id like f.jurisdiction_id || '-%'
     or (coalesce(p_remote, false) and f.applies_to_remote and left(f.jurisdiction_id, 2) = left(p_jurisdiction_id, 2));
$$;

comment on function private.pay_range_required(text, boolean) is 'True when a pay transparency rule in force covers the jurisdiction (its code or an ancestor code), or, for a remote role, when a rule in force in the same country covers remote roles.';
revoke all on function private.pay_range_required(text, boolean) from public, anon, authenticated;

create or replace function private.pay_range_required(p_jurisdiction_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.pay_range_required(p_jurisdiction_id, false);
$$;

comment on function private.pay_range_required(text) is 'True when a pay transparency rule in force covers the jurisdiction (an on-site role).';

-- Publishing (0774's guard, with remote roles) -----------------------------------------------------------------

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
    if new.role_type in ('Contractor', 'Crew', 'Staff') and new.requisition_id is null then
      perform private.refuse('requisition_required', 'Publish Contractor, Crew and Staff opportunities from an Approved requisition.');
    end if;
    if new.requisition_id is not null then
      perform private.assert_requisition_approved(new.requisition_id, new.project_id, new.role_code);
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

comment on function private.guard_opportunity() is 'Opportunities: project and role type fixed; compensation, visibility, deadline, remote work and requisition fixed once published; publishing refuses an unknown jurisdiction, a Contractor, Crew or Staff posting without an Approved requisition for its project and role, any other named requisition that is not Approved, a missing pay range where a pay transparency rule in force covers the jurisdiction or the remote role (1125), Public visibility below the Pro plan, a bid opportunity without a deadline and a removed listing.';

-- Seed ---------------------------------------------------------------------------------------------------------
-- US jurisdictions with pay range posting laws in force or enacted, as A43 found them. Every row waits on
-- the owner's review with counsel (needs_counsel_review); employer size thresholds are not modeled.

insert into private.pay_transparency_rules (jurisdiction_id, requires_pay_range, effective_from, citation, applies_to_remote, needs_counsel_review) values
  ('US-CA', true, '2023-01-01', 'Cal. Lab. Code § 432.3 (SB 1162)', true, true),
  ('US-CO', true, '2021-01-01', 'Colo. Rev. Stat. § 8-5-201 (Equal Pay for Equal Work Act)', true, true),
  ('US-WA', true, '2023-01-01', 'Rev. Code Wash. § 49.58.110', true, true),
  ('US-NY', true, '2023-09-17', 'N.Y. Lab. Law § 194-b', true, true),
  ('US-IL', true, '2025-01-01', '820 ILCS 112/10 (Equal Pay Act of 2003, as amended by P.A. 103-0539)', true, true),
  ('US-MD', true, '2024-10-01', 'Md. Code, Lab. & Empl. § 3-304.2 (as amended by SB 525, 2024)', true, true),
  ('US-HI', true, '2024-01-01', 'Haw. Rev. Stat. § 378-2.4', false, true),
  ('US-MN', true, '2025-01-01', 'Minn. Stat. § 181.173', true, true),
  ('US-VT', true, '2025-07-01', 'Vt. Stat. Ann. tit. 21, § 495o', true, true),
  ('US-MA', true, '2025-10-29', 'Mass. Gen. Laws ch. 149, § 105F', true, true),
  ('US-NJ', true, '2025-06-01', 'N.J. Stat. Ann. § 34:11-56a46 et seq. (P.L. 2024, c. 91)', true, true),
  ('US-DC', true, '2024-06-30', 'D.C. Code § 32-1451 et seq. (Wage Transparency Omnibus Amendment Act of 2023)', true, true)
on conflict (jurisdiction_id, effective_from) do nothing;
