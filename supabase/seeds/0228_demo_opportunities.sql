-- 0228_demo_opportunities.sql
-- A28 Engagements and Marketplace (RRR-30). The demo tenant's Opportunities module (Section 19.6), one engagement
-- lifecycle at every stage from requisition to re-engagement, on the fixed ids of 0000_demo_tenant_conventions.sql:
--   * an Approved staffing requisition and the Published Crew posting made from it, inviting the demo crew person
--   * the crew person's application, shortlisted, offered and accepted, and the Onboarding engagement made from it with
--     its onboarding packet item and a Sent crew agreement
--   * a Draft vendor Bid posting for the demo vendor, and a completed vendor engagement rated by the org
--   * a Talent pool and a Vendor pool for re-engagement
--
-- Guarded on the demo org: nothing loads before 0010 exists. The demo project is created here only when no earlier
-- seed made it (A07 owns it). Idempotent: fixed ids with `on conflict do nothing`, and every state move runs only from its
-- expected state, through the lifecycle engine so each move is in its ledger. Extra fixed ids, all in the 0228 block:
--   Requisition 01920000-0000-7000-8000-000000228001, postings ...228101 and ...228102, application ...228201,
--   offer ...228301, engagements ...228401 (crew) and ...228402 (vendor), requirement ...228501, document ...228601,
--   pools ...228701 (talent) and ...228702 (vendor), counterparty ...228801.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_project constant uuid := '01920000-0000-7000-8000-000000001001';
  v_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  v_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  v_vendor constant uuid := '01920000-0000-7000-8000-000000000301';
  v_requisition constant uuid := '01920000-0000-7000-8000-000000228001';
  v_posting constant uuid := '01920000-0000-7000-8000-000000228101';
  v_bid_posting constant uuid := '01920000-0000-7000-8000-000000228102';
  v_application constant uuid := '01920000-0000-7000-8000-000000228201';
  v_offer constant uuid := '01920000-0000-7000-8000-000000228301';
  v_engagement constant uuid := '01920000-0000-7000-8000-000000228401';
  v_vendor_engagement constant uuid := '01920000-0000-7000-8000-000000228402';
  v_requirement constant uuid := '01920000-0000-7000-8000-000000228501';
  v_document constant uuid := '01920000-0000-7000-8000-000000228601';
  v_talent_pool constant uuid := '01920000-0000-7000-8000-000000228701';
  v_vendor_pool constant uuid := '01920000-0000-7000-8000-000000228702';
  v_counterparty constant uuid := '01920000-0000-7000-8000-000000228801';
begin
  if not exists (select 1 from app.organizations where id = v_org) then
    return;
  end if;

  -- The demo project, when no earlier seed created it.
  insert into app.projects (id, org_id, project_key, name, time_zone, jurisdiction_id, starts_on, ends_on, created_by)
  values (v_project, v_org, 'DPS', 'Demo Summer Series', 'America/New_York', 'US-FL-MIAMI-DADE', '2027-06-04', '2027-06-06', v_owner)
  on conflict (id) do nothing;

  -- Stage 1: requisition, approved under spend authority.
  insert into app.requisitions (id, project_id, role_type, role_code, worker_classification, pay_basis, arrangement, headcount,
    rate_minor, currency_code, starts_on, ends_on, justification, requested_by)
  values (v_requisition, v_project, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', 2,
    95000, 'USD', '2027-06-04', '2027-06-06', 'Two head riggers for the main stage build and show days.', v_owner)
  on conflict (id) do nothing;
  if (select requisition_state from app.requisitions where id = v_requisition) = 'Proposed' then
    perform private.transition_lifecycle('requisition', 'app.requisitions', 'requisition_state', 'app.requisition_state_transitions',
      'requisition_id', v_requisition, 'Proposed', 'Approved', 'Approved within the production labor budget.');
  end if;

  -- Onboarding requirement before any engagement, so the packet includes it.
  insert into app.onboarding_requirements (id, org_id, name, item_kind, role_type, verification_method, is_blocking, valid_for_days, remind_days_before)
  values (v_requirement, v_org, 'Certificate of Insurance', 'Document Upload', 'Crew', 'Reviewer', true, 365, 30)
  on conflict (id) do nothing;

  -- Stage 2: the Crew posting from the requisition, published to the invited crew person.
  insert into app.opportunities (id, project_id, requisition_id, role_type, role_code, title, description, visibility, rate_type,
    pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at)
  values (v_posting, v_project, v_requisition, 'Crew', '5000.51.02', 'Main Stage Head Riggers',
    'Two head riggers for the main stage: build on June 4, shows June 5 and 6. Own harness required.', 'Invited', 'Day',
    90000, 95000, 'USD', '2027-06-04', '2027-06-06', '2027-05-15T23:00:00Z')
  on conflict (id) do nothing;
  insert into app.opportunity_positions (opportunity_id, label, call_at)
  select v_posting, p.label, p.call_at
  from (values ('Head Rigger 1', '2027-06-04T12:00:00Z'::timestamptz), ('Head Rigger 2', '2027-06-04T12:00:00Z'::timestamptz)) p (label, call_at)
  where not exists (select 1 from app.opportunity_positions x where x.opportunity_id = v_posting and x.label = p.label);
  insert into app.opportunity_requirements (opportunity_id, requirement_kind, description)
  select v_posting, 'Equipment', 'Own full-body harness, inspected this year.'
  where not exists (select 1 from app.opportunity_requirements x where x.opportunity_id = v_posting);
  insert into app.opportunity_questions (opportunity_id, prompt, sort_order, is_required)
  select v_posting, 'Which arena or festival rigs have you led?', 1, true
  where not exists (select 1 from app.opportunity_questions x where x.opportunity_id = v_posting);
  insert into app.opportunity_invitations (opportunity_id, person_id)
  select v_posting, v_crew
  where not exists (select 1 from app.opportunity_invitations x where x.opportunity_id = v_posting and x.person_id = v_crew);
  if (select opportunity_state from app.opportunities where id = v_posting) = 'Draft' then
    perform private.transition_lifecycle('opportunity', 'app.opportunities', 'opportunity_state', 'app.opportunity_state_transitions',
      'opportunity_id', v_posting, 'Draft', 'Pending Approval', 'Ready for approval.');
    perform private.transition_lifecycle('opportunity', 'app.opportunities', 'opportunity_state', 'app.opportunity_state_transitions',
      'opportunity_id', v_posting, 'Pending Approval', 'Published', 'Approved for the invited crew.');
  end if;

  -- Stages 3 to 5: application, review, shortlist, offer and acceptance.
  insert into app.applications (id, opportunity_id, applicant_person_id, availability_confirmed, cover_note)
  values (v_application, v_posting, v_crew, true, 'Available all three days; led the arena rig for the spring tour.')
  on conflict (id) do nothing;
  insert into app.application_answers (application_id, opportunity_question_id, answer_text)
  select v_application, q.id, 'Spring arena tour main rig and two festival main stages.'
  from app.opportunity_questions q
  where q.opportunity_id = v_posting
    and not exists (select 1 from app.application_answers a where a.application_id = v_application);
  if (select application_state from app.applications where id = v_application) = 'Submitted' then
    perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
      'application_id', v_application, 'Submitted', 'In Review', 'Screening.');
    perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
      'application_id', v_application, 'In Review', 'Shortlisted', 'Strongest rigging lead experience.');
    insert into app.shortlists (opportunity_id, application_id, rank, note)
    values (v_posting, v_application, 1, 'First choice for Head Rigger 1.');
    insert into app.offers (id, application_id) values (v_offer, v_application);
    insert into app.offer_versions (offer_id, proposed_side, rate_type, amount_minor, currency_code, starts_on, ends_on, message)
    values (v_offer, 'Organization', 'Day', 95000, 'USD', '2027-06-04', '2027-06-06', 'Head Rigger 1 for the Demo Summer Series.');
    perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
      'application_id', v_application, 'Shortlisted', 'Offered', 'Offer sent.');
    perform private.transition_lifecycle('offer', 'app.offers', 'offer_state', 'app.offer_state_transitions',
      'offer_id', v_offer, 'Sent', 'Accepted', 'Accepted by the applicant.');
    perform private.transition_lifecycle('application', 'app.applications', 'application_state', 'app.application_state_transitions',
      'application_id', v_application, 'Offered', 'Accepted', 'Offer accepted.');
  end if;

  -- Stage 6: the engagement from the accepted application, onboarding, with its agreement out for signature.
  insert into app.engagements (id, project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    agreed_rate_minor, currency_code, start_date, end_date, application_id)
  values (v_engagement, v_project, v_crew, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
    95000, 'USD', '2027-06-04', '2027-06-06', v_application)
  on conflict (id) do nothing;
  insert into app.engagement_documents (id, engagement_id, document_kind, title)
  values (v_document, v_engagement, 'Agreement', 'Crew Agreement 2027')
  on conflict (id) do nothing;
  if (select engagement_document_state from app.engagement_documents where id = v_document) = 'Proposed' then
    perform private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
      'app.engagement_document_state_transitions', 'engagement_document_id', v_document, 'Proposed', 'Sent', 'Sent for signature.');
  end if;

  -- A Draft vendor Bid posting for the demo vendor.
  insert into app.opportunities (id, project_id, role_type, role_code, title, description, visibility, rate_type, starts_on, deadline_at)
  values (v_bid_posting, v_project, 'Vendor', '9000.50.02', 'Main Stage Audio System',
    'Line array, consoles and two engineers for June 5 and 6. Line-item bids; bids stay sealed until the deadline.',
    'Invited', 'Bid', '2027-06-05', '2027-05-01T23:00:00Z')
  on conflict (id) do nothing;
  insert into app.opportunity_invitations (opportunity_id, organization_id)
  select v_bid_posting, v_vendor
  where not exists (select 1 from app.opportunity_invitations x where x.opportunity_id = v_bid_posting and x.organization_id = v_vendor);

  -- Stages 7 to 9: a completed vendor engagement from an earlier show, rated, and the vendor pooled for re-engagement.
  insert into app.counterparties (id, org_id, organization_id)
  select v_counterparty, v_org, v_vendor
  where not exists (select 1 from app.counterparties c where c.org_id = v_org and c.organization_id = v_vendor and c.deleted_at is null)
  on conflict (id) do nothing;
  insert into app.engagements (id, project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis,
    arrangement, start_date, end_date)
  select v_vendor_engagement, v_project, '01920000-0000-7000-8000-000000000302', c.id, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED',
    'Day Rate', 'Per Engagement', '2027-01-10', '2027-01-12'
  from app.counterparties c where c.org_id = v_org and c.organization_id = v_vendor and c.deleted_at is null
  on conflict (id) do nothing;
  if (select engagement_state from app.engagements where id = v_vendor_engagement) = 'Onboarding' then
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', v_vendor_engagement, 'Onboarding', 'Active', 'Onboarding complete.');
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', v_vendor_engagement, 'Active', 'Closing', 'Show complete; close-out started.');
    perform private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
      'engagement_id', v_vendor_engagement, 'Closing', 'Complete', 'Final invoice paid and access closed.');
    insert into app.ratings (engagement_id, rater_side, score, comment)
    values (v_vendor_engagement, 'Organization', 5, 'On time at load-in and the system was clean all show.');
  end if;

  insert into app.talent_pools (id, org_id, name, pool_kind) values
    (v_talent_pool, v_org, 'Trusted Riggers', 'Talent'),
    (v_vendor_pool, v_org, 'Preferred Audio Vendors', 'Vendor')
  on conflict (id) do nothing;
  insert into app.pool_members (talent_pool_id, person_id, standing)
  select v_talent_pool, v_crew, 'Preferred'
  where not exists (select 1 from app.pool_members m where m.talent_pool_id = v_talent_pool and m.person_id = v_crew and m.deleted_at is null);
  insert into app.pool_members (talent_pool_id, organization_id, standing)
  select v_vendor_pool, v_vendor, 'Preferred'
  where not exists (select 1 from app.pool_members m where m.talent_pool_id = v_vendor_pool and m.organization_id = v_vendor and m.deleted_at is null);
end;
$$;
