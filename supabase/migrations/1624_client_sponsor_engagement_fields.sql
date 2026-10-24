-- 1624_client_sponsor_engagement_fields.sql
--
-- Notification and access decisions (ADR 0022, 1620-1629), RRR-125; ADR 0033 decision 69 (2026-10-23), which
-- settles ADR 0019's open question on Client and Sponsor engagements. A client pays the org and a sponsor contributes to
-- a project; neither works for the org, so their engagements drop the fields that only describe work: the canon role
-- and worker classification (which also chose the onboarding documents, a W-9 for an independent contractor), the pay
-- basis, arrangement, agreed rate and its currency, and the employment status, FLSA status and labor agreement. Hours,
-- timesheets, shifts and pay are rows that point at a worker's engagement, never fields of it.
--   * role_code and worker_classification become nullable; engagements_work_terms requires them for every other role
--     type and requires all nine fields to be NULL for Client and Sponsor. Existing Client and Sponsor engagements lose
--     theirs first.
--   * private.engagement_compliance (from 0700) refuses work terms on a Client or Sponsor engagement with a named rule
--     (engagement_work_terms) before the constraint would, and skips the worker rules XOS-ENG-1 to 6 for them.
--   * app.create_engagement_from_application (from 0775) keeps no role, classification or pay terms when the
--     opportunity is for a client or sponsor, so API v1's create body, which requires a classification, still works.
--   * app.engagement_resolved (0700), app.engagement_board (0775) and api_external.engagements (1390) joined the Roles
--     Library and the classification with inner joins; they join them with left joins, so an engagement without a role
--     stays listed. Their columns are unchanged, and the workforce columns read NULL for those engagements (API v1
--     keeps every field).

-- 1. Nullable for clients and sponsors only ---------------------------------------------------------------------------

alter table app.engagements alter column role_code drop not null, alter column worker_classification drop not null;

-- 2. The engagement contract rules (from 0700) -------------------------------------------------------------------------

create or replace function private.engagement_compliance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wc xpms.worker_classification;
  v_rule_ot numeric;
  v_law_ot numeric;
  v_jurisdiction text;
begin
  -- A client pays the org and a sponsor contributes to the project: neither works for the org, so neither carries a
  -- canon role, a worker classification, pay terms or employment terms (ADR 0033 decision 69, 1624). The rules below are
  -- about workers and do not apply.
  if new.role_type in ('Client', 'Sponsor') then
    if num_nonnulls(new.role_code, new.worker_classification, new.pay_basis, new.arrangement, new.agreed_rate_minor,
         new.currency_code, new.employment_status, new.flsa_status, new.labor_agreement_id) > 0 then
      perform private.refuse('engagement_work_terms', format('%s engagements carry no role, worker classification, pay or employment terms.', new.role_type));
    end if;
    return new;
  end if;
  if new.role_code is null or new.worker_classification is null then
    perform private.refuse('engagement_role_required', 'An engagement of someone who works for the org names a canon role and worker classification.');
  end if;
  select * into v_wc from xpms.worker_classification w where w.code = new.worker_classification;
  if (new.pay_basis is null) <> (v_wc.payment_channel = 'None') then
    perform private.refuse('XOS-ENG-1', format('%s engagements %s a pay basis.', v_wc.label,
      case when v_wc.payment_channel = 'None' then 'cannot have' else 'require' end));
  end if;
  if v_wc.is_employee and (new.employment_status is null or new.flsa_status is null) then
    perform private.refuse('XOS-ENG-2', 'Employee engagements require employment status and FLSA status.');
  end if;
  if not v_wc.is_employee and (new.employment_status is not null or new.flsa_status is not null or new.labor_agreement_id is not null) then
    perform private.refuse('XOS-ENG-3', 'Employment status, FLSA status and labor agreements apply only to employees.');
  end if;
  if new.worker_classification = 'VENDOR_SUPPLIED' and new.counterparty_id is null then
    perform private.refuse('XOS-ENG-4', 'Vendor-supplied engagements must name the vendor.');
  end if;
  if not exists (
    select 1 from app.organizations o
    join xpms.classification_organization_type c
      on c.organization_type = o.organization_type and c.worker_classification = new.worker_classification
    where o.id = new.org_id
  ) then
    perform private.refuse('XOS-ENG-6', format('%s engagements are not permitted for this organization type.', v_wc.label));
  end if;
  if new.flsa_status = 'Nonexempt' then
    select o.ot_multiplier into v_rule_ot
    from xpms.rate_card rc join xpms.overtime_rule o on o.rule_id = rc.overtime_rule_id
    where rc.role_code = new.role_code and rc.worker_classification = new.worker_classification
      and rc.pay_basis = new.pay_basis and rc.arrangement = new.arrangement;
    select coalesce(p.jurisdiction_id, v.jurisdiction_id) into v_jurisdiction
    from app.projects p left join app.venues v on v.id = p.venue_id
    where p.id = new.project_id;
    v_law_ot := xpms.min_ot_multiplier(v_jurisdiction);
    if v_law_ot is not null and v_rule_ot < v_law_ot then
      perform private.refuse('XOS-ENG-5', format('Nonexempt employees need an overtime multiplier of at least %s here; the rate card rule gives %s.', v_law_ot, v_rule_ot));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.engagement_compliance() is 'Before insert or update on engagements: a Client or Sponsor engagement carries no role, worker classification, pay or employment terms (engagement_work_terms, 1624) and no worker rule applies to it; every other engagement names a canon role and classification (engagement_role_required) and meets the engagement contract rules XOS-ENG-1 (pay basis only for paid classifications), XOS-ENG-2 (employees carry employment and FLSA status), XOS-ENG-3 (those and labor agreements only for employees), XOS-ENG-4 (vendor-supplied labor names the vendor), XOS-ENG-6 (classification permitted for the organization type, D17) and XOS-ENG-5 (a nonexempt employee''s overtime rule meets the strictest minimum up the project''s jurisdiction chain). Each refusal names its rule.';
revoke all on function private.engagement_compliance() from public, anon, authenticated;

-- 3. Existing client and sponsor engagements lose their work terms, then the constraint holds ---------------------------

update app.engagements
set role_code = null, worker_classification = null, pay_basis = null, arrangement = null, agreed_rate_minor = null,
  currency_code = null, employment_status = null, flsa_status = null, labor_agreement_id = null
where role_type in ('Client', 'Sponsor')
  and num_nonnulls(role_code, worker_classification, pay_basis, arrangement, agreed_rate_minor, currency_code,
    employment_status, flsa_status, labor_agreement_id) > 0;

alter table app.engagements add constraint engagements_work_terms check (
  case when role_type in ('Client', 'Sponsor')
    then num_nonnulls(role_code, worker_classification, pay_basis, arrangement, agreed_rate_minor, currency_code,
      employment_status, flsa_status, labor_agreement_id) = 0
    else role_code is not null and worker_classification is not null end);

comment on column app.engagements.role_code is 'Canon role (Roles Library, decision D12). NULL exactly for Client and Sponsor engagements, which carry no work terms (1624).';
comment on column app.engagements.worker_classification is 'Canon worker classification (decision D16). NULL exactly for Client and Sponsor engagements (1624).';
comment on column app.engagements.pay_basis is 'Canon pay basis; NULL for an unpaid classification (XOS-ENG-1) and for Client and Sponsor engagements (1624).';
comment on column app.engagements.arrangement is 'Canon arrangement; NULL exactly when the pay basis is NULL.';
comment on column app.engagements.agreed_rate_minor is 'Agreed rate in minor units per pay basis unit, when it differs from the rate card; NULL reads the rate card, and is always NULL for Client and Sponsor engagements (1624). Restricted (data.restricted.read.payroll).';

-- 4. Engaging a client or sponsor from an accepted application (from 0775) ----------------------------------------------

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
  v_work_terms boolean;
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
  v_work_terms := v_opp.role_type not in ('Client', 'Sponsor');
  if v_work_terms and v_opp.role_code is null then
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
  values (v_opp.project_id, v_app.applicant_person_id, v_counterparty, v_opp.role_type,
    -- A client or sponsor engagement carries no work terms (1624): the classification and pay terms given are not kept.
    case when v_work_terms then v_opp.role_code end, case when v_work_terms then p_worker_classification end,
    case when v_work_terms then p_pay_basis end, case when v_work_terms then p_arrangement end,
    case when v_work_terms and p_pay_basis is not null then v_terms.amount_minor end,
    case when v_work_terms and p_pay_basis is not null and v_terms.amount_minor is not null then v_terms.currency_code end,
    coalesce(p_start_date, v_terms.starts_on, v_opp.starts_on), coalesce(p_end_date, v_terms.ends_on, v_opp.ends_on), p_application_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.create_engagement_from_application(uuid, text, text, text, date, date) is 'Section 4.4.4 stage 5 to 6: turns an Accepted application into an Onboarding engagement on the opportunity''s project and role, for the applicant person or the applicant account (adding its counterparty row when the org has none), with the accepted offer''s amount as the agreed rate and its dates unless given. A Client or Sponsor engagement keeps no role, classification or pay terms (1624). The engagement contract rules (XOS-ENG-1 to 6) and the plan limit apply. Needs opportunities.engagement.write. Returns the engagement id.';
revoke all on function app.create_engagement_from_application(uuid, text, text, text, date, date) from public, anon;
grant execute on function app.create_engagement_from_application(uuid, text, text, text, date, date) to authenticated, service_role;

-- 5. Views keep engagements without a role -----------------------------------------------------------------------------

create or replace view app.engagement_resolved as
select e.id as engagement_id, e.org_id, e.project_id, e.person_id, e.counterparty_id, e.role_type, e.role_code, r.job_title,
  wc.label as worker_classification, wc.payment_channel, e.pay_basis, e.arrangement,
  rc.rate_card_id,
  case when private.has_capability(e.org_id, 'data.restricted.read.payroll')
       then coalesce(e.agreed_rate_minor, ol.rate_minor, rc.standard_rate_minor) end as rate_minor,
  case when e.agreed_rate_minor is not null then e.currency_code
       when ol.rate_minor is not null then ol.currency_code
       else rc.currency_code end as rate_currency_code,
  not private.has_capability(e.org_id, 'data.restricted.read.payroll') as is_masked,
  ot.ot_multiplier, ot.dt_multiplier, e.employment_status, e.flsa_status, e.labor_agreement_id,
  e.start_date, e.end_date, e.engagement_state
from app.engagements e
left join xpms.role r on r.role_code = e.role_code
left join xpms.worker_classification wc on wc.code = e.worker_classification
left join xpms.rate_card rc on rc.role_code = e.role_code and rc.worker_classification = e.worker_classification
  and rc.pay_basis = e.pay_basis and rc.arrangement = e.arrangement
left join lateral (
  select l.rate_minor, c.currency_code, l.overtime_rule_id
  from app.rate_card_lines l join app.rate_cards c on c.id = l.rate_card_id
  where l.org_id = e.org_id and l.deleted_at is null and c.deleted_at is null
    and l.role_code = e.role_code and l.worker_classification = e.worker_classification
    and l.pay_basis = e.pay_basis and l.arrangement = e.arrangement
    and c.effective_from <= e.start_date and (c.effective_to is null or c.effective_to >= e.start_date)
  order by c.effective_from desc
  limit 1
) ol on true
left join xpms.overtime_rule ot on ot.rule_id = coalesce(ol.overtime_rule_id, rc.overtime_rule_id)
where e.deleted_at is null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

create or replace view app.engagement_board as
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
left join xpms.role r on r.role_code = e.role_code
left join app.people pe on pe.id = e.person_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations ac on ac.id = c.organization_id
where e.deleted_at is null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

create or replace view api_external.engagements as
select e.id, e.org_id, o.name as org_name, e.project_id, p.name as project_name, e.role_type, e.role_code, r.job_title,
  e.person_id, c.organization_id as account_id, e.pay_basis, e.arrangement,
  case when 'money' = any (a.areas) then coalesce(e.agreed_rate_minor, ol.rate_minor, rc.standard_rate_minor) end as rate_minor,
  case when 'money' = any (a.areas) then
    case when e.agreed_rate_minor is not null then e.currency_code when ol.rate_minor is not null then ol.currency_code else rc.currency_code end
  end as rate_currency_code,
  e.start_date, e.end_date, e.engagement_state, a.areas, p.time_zone as project_time_zone
from app.engagements e
join app.organizations o on o.id = e.org_id
join app.projects p on p.id = e.project_id
left join xpms.role r on r.role_code = e.role_code
left join app.counterparties c on c.id = e.counterparty_id
left join xpms.rate_card rc on rc.role_code = e.role_code and rc.worker_classification = e.worker_classification
  and rc.pay_basis = e.pay_basis and rc.arrangement = e.arrangement
left join lateral (
  select l.rate_minor, k.currency_code
  from app.rate_card_lines l join app.rate_cards k on k.id = l.rate_card_id
  where l.org_id = e.org_id and l.deleted_at is null and k.deleted_at is null
    and l.role_code = e.role_code and l.worker_classification = e.worker_classification
    and l.pay_basis = e.pay_basis and l.arrangement = e.arrangement
    and k.effective_from <= e.start_date and (k.effective_to is null or k.effective_to >= e.start_date)
  order by k.effective_from desc limit 1
) ol on true
cross join lateral (select array(select s from private.engagement_scope(e.id) s order by s) as areas) a
where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'));
