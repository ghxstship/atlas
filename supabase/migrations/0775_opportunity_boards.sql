-- 0775_opportunity_boards.sql
-- A28 Engagements and Marketplace (RRR-30). Read models and one RPC for the Atlas Opportunities pages (Section 4.5.5:
-- Pipeline board by application state, Engagements, Onboarding, Ratings) and for the API handlers:
--   * app.application_board: every application the member reads with its applicant's name, shortlist rank, next
--     interview, the offer in force and the bid total only once the bid is unsealed for the member (Section 8.7)
--   * app.engagement_board: every engagement the member reads with the party's name, onboarding progress, documents
--     awaiting a signature, deliverables awaiting review and the rating status (stage 8 close-out)
--   * app.create_engagement_from_application: stage 5 to 6, an accepted application becomes an engagement with the terms
--     of its accepted offer; an account applicant gets its counterparty row on the way
-- Both views run as owner with their own row filters (ADR 0016 item 14): external applicants' and accounts' names live
-- on app.people and app.organizations, whose own policies hide them from org members.

create view app.application_board as
select a.id as application_id, a.org_id, a.opportunity_id, o.title as opportunity_title, o.project_id, pj.project_key, o.role_type,
  case when a.applicant_person_id is not null then 'Person' else 'Account' end as applicant_kind,
  coalesce(pe.full_name, ac.name) as applicant_name, a.applicant_person_id, a.applicant_organization_id,
  a.application_state, a.created_at as submitted_at, a.availability_confirmed, a.cover_note, a.proposed_fee_minor, a.currency_code,
  sl.rank as shortlist_rank,
  (select min(i.scheduled_at) from app.interviews i where i.application_id = a.id and i.deleted_at is null and i.scheduled_at >= now()) as next_interview_at,
  ofr.id as offer_id, ofr.offer_state, lv.proposed_side as offer_turn_side, lv.rate_type as offer_rate_type, lv.amount_minor as offer_amount_minor,
  lv.currency_code as offer_currency_code, lv.expires_at as offer_expires_at,
  (b.id is not null) as has_bid,
  (b.id is not null and not private.bid_readable_by_org(a.id)) as bid_sealed,
  case when b.id is not null and private.bid_readable_by_org(a.id) then bt.total_minor end as bid_total_minor,
  (select e.id from app.engagements e where e.application_id = a.id and e.deleted_at is null limit 1) as engagement_id,
  b.currency_code as bid_currency_code
from app.applications a
join app.opportunities o on o.id = a.opportunity_id
join app.projects pj on pj.id = o.project_id
left join app.people pe on pe.id = a.applicant_person_id
left join app.organizations ac on ac.id = a.applicant_organization_id
left join app.shortlists sl on sl.application_id = a.id and sl.deleted_at is null
left join app.offers ofr on ofr.application_id = a.id and ofr.deleted_at is null and ofr.offer_state in ('Sent', 'Countered', 'Accepted')
left join lateral (select v.* from app.offer_versions v where v.offer_id = ofr.id order by v.version_number desc limit 1) lv on true
left join app.bids b on b.application_id = a.id and b.deleted_at is null
left join lateral (
  select case when count(l.id) > 0 and count(l.id) filter (where l.unit_price_minor is null) = 0
              then sum(round(l.quantity * l.unit_price_minor))::bigint end as total_minor
  from app.bid_lines l where l.bid_id = b.id and l.deleted_at is null
) bt on true
where a.deleted_at is null
  and o.project_id in (select private.project_ids_with('opportunities.application.read'));

call private.describe('app.application_board', 'Applications as the Pipeline board reads them (Section 4.5.5): applicant name, shortlist rank, next interview, the offer in force and whose turn it is, and the bid total only once the bid is unsealed for the reader (Section 8.7). Rows follow opportunities.application.read on the project.', array[
  'application_id', 'Application.', 'org_id', 'Org.', 'opportunity_id', 'Opportunity.', 'opportunity_title', 'Opportunity title.',
  'project_id', 'Project.', 'project_key', 'Project key.', 'role_type', 'External role type sought.',
  'applicant_kind', 'Person or Account.', 'applicant_name', 'Applicant name.', 'applicant_person_id', 'Applying person.',
  'applicant_organization_id', 'Applying account.', 'application_state', 'Application state.', 'submitted_at', 'When submitted.',
  'availability_confirmed', 'True when availability was confirmed.', 'cover_note', 'Note from the applicant.',
  'proposed_fee_minor', 'Fee the applicant proposed in minor units.', 'currency_code', 'Currency of the proposed fee.',
  'shortlist_rank', 'Shortlist rank; NULL when not shortlisted.', 'next_interview_at', 'Next scheduled interview or audition.',
  'offer_id', 'Live offer.', 'offer_state', 'Offer state.', 'offer_turn_side', 'Side that proposed the terms in force; the other side answers.',
  'offer_rate_type', 'Rate type of the terms in force.', 'offer_amount_minor', 'Amount of the terms in force in minor units.',
  'offer_currency_code', 'Currency of the terms in force.', 'offer_expires_at', 'When the terms in force lapse.',
  'has_bid', 'True when the applicant submitted a bid.', 'bid_sealed', 'True while the bid stays sealed for the reader.',
  'bid_total_minor', 'Bid total in minor units once unsealed; NULL while sealed or with an unpriced line.',
  'engagement_id', 'Engagement created from the application.', 'bid_currency_code', 'Currency of the bid.']);

create or replace function private.open_blocking_count(p_engagement_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from private.engagement_open_blocking_requirements(p_engagement_id)
  where p_engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'));
$$;

comment on function private.open_blocking_count(uuid) is 'How many blocking onboarding requirements of the engagement are not yet satisfied, for members who read the engagement; 0 for anyone else.';

create view app.engagement_board as
select e.id as engagement_id, e.org_id, e.project_id, pj.project_key, pj.name as project_name,
  coalesce(pe.full_name, ac.name) as party_name, e.person_id, c.organization_id as account_id, ac.name as account_name,
  e.role_type, e.role_code, r.job_title, e.worker_classification, e.engagement_state, e.start_date, e.end_date, e.application_id,
  private.open_blocking_count(e.id) as open_blocking_count,
  (select count(*) from app.onboarding_items i where i.engagement_id = e.id and i.deleted_at is null) as onboarding_item_count,
  (select count(*) from app.engagement_documents d where d.engagement_id = e.id and d.deleted_at is null
     and d.engagement_document_state in ('Sent', 'Signed')) as documents_in_flight,
  (select count(*) from app.engagement_deliverables d where d.engagement_id = e.id and d.deleted_at is null
     and d.deliverable_state = 'Submitted') as deliverables_to_review,
  exists (select 1 from app.ratings x where x.engagement_id = e.id and x.rater_side = 'Organization' and x.deleted_at is null) as org_rated,
  exists (select 1 from app.ratings x where x.engagement_id = e.id and x.rater_side = 'Party' and x.deleted_at is null) as party_rated,
  private.rating_released(e.id) as ratings_released
from app.engagements e
join app.projects pj on pj.id = e.project_id
join xpms.role r on r.role_code = e.role_code
left join app.people pe on pe.id = e.person_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations ac on ac.id = c.organization_id
where e.deleted_at is null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

call private.describe('app.engagement_board', 'Engagements as the Engagements and Onboarding pages read them: party name, onboarding progress, documents awaiting a signature or countersignature, deliverables to review and whether each side has rated (Section 4.4.4 stages 6 to 9). Rows follow opportunities.engagement.read on the project.', array[
  'engagement_id', 'Engagement.', 'org_id', 'Org.', 'project_id', 'Project.', 'project_key', 'Project key.', 'project_name', 'Project name.',
  'party_name', 'Engaged person, or the account when no person is named.', 'person_id', 'Engaged person.', 'account_id', 'Engaged account.',
  'account_name', 'Engaged account name.', 'role_type', 'External role type.', 'role_code', 'Canon role.', 'job_title', 'Job title from the Roles Library.',
  'worker_classification', 'Canon worker classification.', 'engagement_state', 'Engagement state.', 'start_date', 'First day.', 'end_date', 'Last day.',
  'application_id', 'Application the engagement came from.', 'open_blocking_count', 'Blocking onboarding requirements not yet satisfied.',
  'onboarding_item_count', 'Onboarding items.', 'documents_in_flight', 'Documents Sent or Signed and not yet executed.',
  'deliverables_to_review', 'Deliverables handed in and awaiting the org.', 'org_rated', 'True once the org rated the party.',
  'party_rated', 'True once the party rated the org.', 'ratings_released', 'True once both ratings show.']);

-- Stage 5 to 6 ------------------------------------------------------------------------------------------------------------------

create or replace function app.create_engagement_from_application(
  p_application_id uuid,
  p_worker_classification text,
  p_pay_basis text,
  p_arrangement text,
  p_start_date date,
  p_end_date date
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_app app.applications;
  v_opp app.opportunities;
  v_terms app.offer_versions;
  v_counterparty uuid;
  v_id uuid;
begin
  perform private.require_person();
  select a.* into v_app from app.applications a where a.id = p_application_id and a.deleted_at is null;
  select o.* into v_opp from app.opportunities o where o.id = v_app.opportunity_id;
  if v_app.id is null or not private.can_on_project(v_opp.project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'opportunities.engagement.write is required on the project';
  end if;
  if v_app.application_state <> 'Accepted' then
    perform private.refuse('engagement_application_not_accepted', 'An engagement comes from an accepted application.');
  end if;
  if exists (select 1 from app.engagements e where e.application_id = p_application_id and e.deleted_at is null) then
    perform private.refuse('engagement_already_created', 'This application already has its engagement.');
  end if;
  if v_opp.role_code is null then
    perform private.refuse('engagement_role_required', 'Give the opportunity a canon role before engaging from it.');
  end if;
  select v.* into v_terms from app.offers o join app.offer_versions v on v.offer_id = o.id
  where o.application_id = p_application_id and o.offer_state = 'Accepted' and o.deleted_at is null
  order by v.version_number desc limit 1;
  if v_app.applicant_organization_id is not null then
    select c.id into v_counterparty from app.counterparties c
    where c.org_id = v_app.org_id and c.organization_id = v_app.applicant_organization_id and c.deleted_at is null;
    if v_counterparty is null then
      insert into app.counterparties (org_id, organization_id) values (v_app.org_id, v_app.applicant_organization_id)
      returning id into v_counterparty;
    end if;
  end if;
  insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    agreed_rate_minor, currency_code, start_date, end_date, application_id)
  values (v_opp.project_id, v_app.applicant_person_id, v_counterparty, v_opp.role_type, v_opp.role_code, p_worker_classification,
    p_pay_basis, p_arrangement, case when p_pay_basis is not null then v_terms.amount_minor end,
    case when p_pay_basis is not null and v_terms.amount_minor is not null then v_terms.currency_code end,
    coalesce(p_start_date, v_terms.starts_on, v_opp.starts_on), coalesce(p_end_date, v_terms.ends_on, v_opp.ends_on), p_application_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.create_engagement_from_application(uuid, text, text, text, date, date) is 'Section 4.4.4 stage 5 to 6: turns an Accepted application into an Onboarding engagement on the opportunity''s project and role, for the applicant person or the applicant account (adding its counterparty row when the org has none), with the accepted offer''s amount as the agreed rate and its dates unless given. The engagement contract rules (XOS-ENG-1 to 6) and the plan limit apply. Needs opportunities.engagement.write. Returns the engagement id.';

-- Privileges ---------------------------------------------------------------------------------------------------------------------

revoke all on app.application_board, app.engagement_board from public, anon;
grant select on app.application_board, app.engagement_board to authenticated, service_role;
revoke all on function private.open_blocking_count(uuid) from public, anon;
grant execute on function private.open_blocking_count(uuid) to authenticated, service_role;
revoke all on function app.create_engagement_from_application(uuid, text, text, text, date, date) from public, anon;
grant execute on function app.create_engagement_from_application(uuid, text, text, text, date, date) to authenticated, service_role;
