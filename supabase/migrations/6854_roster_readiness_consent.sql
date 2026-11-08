-- 6854_roster_readiness_consent.sql
-- RRR-248, ADR 0164 (merge train 11). R11's crew readiness grid (6220) said whether dietary and accessibility needs were
-- on file for anyone who shared the category, and that a person shared Dietary Needs under Allergies. A value saved
-- before consent was recorded, or kept after a withdrawal, is not readable by anyone else (6850, 6851), so the grid must
-- not say it exists either: app.roster_readiness now reads Not Shared for those three categories unless the person's own
-- consent for the category stands (private.sensitive_consent_stands, 6850). Everything else is 6220's, unchanged.

create or replace function app.roster_readiness(p_project_id uuid)
returns table (
  roster_entry_id uuid,
  engagement_id uuid,
  party_label text,
  person_label text,
  role_code text,
  entry_state app.roster_entry_state,
  category text,
  cell_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact boolean;
  v_emergency boolean;
  v_dietary boolean;
  v_accessibility boolean;
  v_passport boolean;
  v_medical boolean;
  v_uniform boolean;
  v_travel boolean;
  v_vehicle boolean;
begin
  perform private.require_person();
  if p_project_id is null or not (private.can_on_project(p_project_id, 'advancing.packet.read')
      or private.can_on_project(p_project_id, 'opportunities.engagement.read')) then
    raise exception using errcode = '42501', message = 'the crew readiness of this project is not readable';
  end if;
  v_contact := private.can_read_work_detail_category(p_project_id, 'Contact');
  v_emergency := private.can_read_work_detail_category(p_project_id, 'Emergency Contacts');
  v_dietary := private.can_read_work_detail_category(p_project_id, 'Dietary Needs');
  v_accessibility := private.can_read_work_detail_category(p_project_id, 'Accessibility Needs');
  v_passport := private.can_read_work_detail_category(p_project_id, 'Passport');
  v_medical := private.can_on_project(p_project_id, 'data.restricted.read.medical');
  v_uniform := private.can_read_project_fact_kind(p_project_id, 'Uniform');
  v_travel := private.can_read_project_fact_kind(p_project_id, 'Travel');
  v_vehicle := private.can_read_project_fact_kind(p_project_id, 'Vehicle');

  return query
  with entries as (
    select r.id, r.engagement_id, r.role_code, r.entry_state, r.person_response,
      private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) as person_id,
      private.advance_party_label(e.project_id, e.person_id, e.counterparty_id) as party_label,
      r.is_self, r.created_at
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
    where e.project_id = p_project_id and e.engagement_state not in ('Complete', 'Canceled')
      and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  ),
  facts as (
    select x.*, p.full_name as person_label,
      coalesce(s.categories, '{}'::app.work_detail_category[]) as shared,
      w.person_id is not null as has_details,
      coalesce(cardinality(w.dietary_needs) > 0 or w.dietary_notes is not null, false) as dietary_on_file,
      coalesce(cardinality(w.accessibility_needs) > 0 or w.accessibility_notes is not null, false) as accessibility_on_file,
      -- ADR 0164: no one else reads a person's dietary or accessibility needs, or learns they exist, unless the person's
      -- own consent for the category stands.
      x.person_id is not null and private.sensitive_consent_stands(x.person_id, 'Dietary and Allergies') as dietary_consent,
      x.person_id is not null and private.sensitive_consent_stands(x.person_id, 'Accessibility') as accessibility_consent,
      exists (select 1 from app.person_emergency_contacts c where c.person_id = x.person_id and c.deleted_at is null) as emergency_on_file,
      x.person_id is not null and (private.recipient_address(x.person_id, 'Email') is not null
        or private.recipient_address(x.person_id, 'SMS') is not null) as contact_on_file,
      private.project_fact_offered(x.engagement_id, 'Travel') as travel_offered,
      private.project_fact_offered(x.engagement_id, 'Uniforms') as uniforms_offered,
      private.project_fact_offered(x.engagement_id, 'Parking') as parking_offered,
      exists (select 1 from app.roster_travel_requests t where t.roster_entry_id = x.id and t.deleted_at is null) as has_travel,
      exists (select 1 from app.roster_uniform_sizes u where u.roster_entry_id = x.id and u.deleted_at is null) as has_uniform,
      exists (select 1 from app.roster_vehicles v where v.roster_entry_id = x.id and v.deleted_at is null) as has_vehicle
    from entries x
    left join app.people p on p.id = x.person_id
    left join app.work_detail_shares s on s.roster_entry_id = x.id and s.revoked_at is null and s.deleted_at is null
    left join app.person_work_details w on w.person_id = x.person_id and w.deleted_at is null
  )
  select f.id, f.engagement_id, f.party_label, f.person_label, f.role_code, f.entry_state, g.category, g.cell_state
  from facts f
  cross join lateral (values
    (1, 'Acceptance', case f.person_response when 'Accepted' then 'Accepted' when 'Declined' then 'Declined' else 'Awaiting Person' end),
    (2, 'Contact', case when not v_contact then 'Hidden' when not ('Contact' = any (f.shared)) then 'Not Shared'
      when f.contact_on_file then 'On File' else 'Missing' end),
    (3, 'Emergency Contacts', case when not v_emergency then 'Hidden' when not ('Emergency Contacts' = any (f.shared)) then 'Not Shared'
      when f.emergency_on_file then 'On File' else 'Missing' end),
    (4, 'Dietary Needs', case when not v_dietary then 'Hidden'
      when not ('Dietary Needs' = any (f.shared)) or not f.dietary_consent then 'Not Shared'
      when f.dietary_on_file then 'On File' else 'Missing' end),
    (5, 'Accessibility Needs', case when not v_accessibility then 'Hidden'
      when not ('Accessibility Needs' = any (f.shared)) or not f.accessibility_consent then 'Not Shared'
      when f.accessibility_on_file then 'On File' else 'Missing' end),
    -- Owner decision 5: whether an allergy exists never shows, only whether the person shares the category it lives in.
    (6, 'Allergies', case when not v_medical then 'Hidden'
      when 'Dietary Needs' = any (f.shared) and f.dietary_consent then 'Shared' else 'Not Shared' end),
    (7, 'Passport', case when not v_passport then 'Hidden' when not f.travel_offered then 'Not Offered'
      when 'Passport' = any (f.shared) then 'Shared' else 'Not Shared' end),
    (8, 'Uniform', case when not v_uniform then 'Hidden' when not f.uniforms_offered then 'Not Offered'
      when f.has_uniform then 'Submitted' else 'Missing' end),
    (9, 'Travel', case when not v_travel then 'Hidden' when not f.travel_offered then 'Not Offered'
      when f.has_travel then 'Submitted' else 'Missing' end),
    (10, 'Vehicle', case when not v_vehicle then 'Hidden' when not f.parking_offered then 'Not Offered'
      when f.has_vehicle then 'Submitted' else 'Missing' end)
  ) as g (sort, category, cell_state)
  order by f.party_label nulls last, f.is_self desc, f.person_label nulls last, f.created_at, f.id, g.sort;
end;
$$;

comment on function app.roster_readiness(uuid) is 'R11 crew readiness (Section 11.11; owner decisions 4 and 5): for each live, non-Withdrawn roster entry on the project whose engagement is not Complete or Canceled, one row per category with its state only. Acceptance is Accepted, Awaiting Person or Declined. Contact, Emergency Contacts, Dietary Needs and Accessibility Needs are Not Shared, On File or Missing, for readers of the category (private.work_detail_category_capabilities). Allergies are Shared or Not Shared (whether the person shares Dietary Needs, never whether an allergy exists), only for holders of data.restricted.read.medical. Passport is Shared or Not Shared, or Not Offered without travel. Uniform, Travel and Vehicle are Submitted or Missing, or Not Offered when the offering is off, for readers of the project fact kind. Dietary Needs, Accessibility Needs and Allergies read Not Shared unless the person''s own consent for the category stands (ADR 0164, private.sensitive_consent_stands). A category the caller may not read is Hidden. No value column: no Confidential or Restricted value leaves the database, so nothing is logged. Refuses 42501 unless the caller holds advancing.packet.read or opportunities.engagement.read on the project.';
revoke all on function app.roster_readiness(uuid) from public, anon;
grant execute on function app.roster_readiness(uuid) to authenticated, service_role;
