-- 1340_a78.sql
-- A78 Work Details (RRR-123, migration 1340, finding A65-003): the demo crew person's work details, emergency contact
-- and loyalty program, shared with their crew engagement (0228's ...228401) under work_details_sharing consent, so
-- Atlas's engagement record shows the org side; the demo Owner's own sizes and contact for Atlas Settings, Work Details;
-- and the crew person's given and family names (Section 15). Every value is fictional: phones in the 555-01xx range,
-- addresses on example.com, and a passport number that reads TEST.
-- Builds on 0010 and 0228 and loads cleanly without them. Idempotent: fixed ids in the 1340 block with
-- `on conflict do nothing`, and the share is written only when it does not exist yet. Extra fixed ids:
--   work details ...1340001 (crew) and ...1340002 (Owner), emergency contacts ...1340101 (crew) and ...1340102
--   (Owner), loyalty program ...1340201, consent ...1340301, share ...1340401.

do $$
declare
  v_org constant uuid := '01920000-0000-7000-8000-000000000001';
  v_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  v_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  v_engagement constant uuid := '01920000-0000-7000-8000-000000228401';
  v_crew_details constant uuid := '01920000-0000-7000-8000-000001340001';
  v_owner_details constant uuid := '01920000-0000-7000-8000-000001340002';
  v_crew_contact constant uuid := '01920000-0000-7000-8000-000001340101';
  v_owner_contact constant uuid := '01920000-0000-7000-8000-000001340102';
  v_program constant uuid := '01920000-0000-7000-8000-000001340201';
  v_consent constant uuid := '01920000-0000-7000-8000-000001340301';
  v_share constant uuid := '01920000-0000-7000-8000-000001340401';
  v_categories constant app.work_detail_category[] :=
    array['Emergency Contacts', 'Uniform Sizes', 'Dietary Needs', 'Passport']::app.work_detail_category[];
begin
  if exists (select 1 from app.people where id = v_crew) then
    update app.people set given_name = 'Demo', family_name = 'Crew Member'
    where id = v_crew and given_name is null and family_name is null;

    perform private.begin_trusted_operation('passport_number_write');
    insert into app.person_work_details (id, person_id, shirt_size, jacket_size, pants_size, shoe_size, glove_size,
      dietary_needs, allergies, seat_preference, meal_preference, home_airport, passport_number, passport_number_last4,
      passport_issuing_country, passport_expires_on, passport_name)
    values (v_crew_details, v_crew, 'L', 'L', '34x32', 'US 11', 'L', '{Vegetarian}', 'Shellfish, mild', 'Aisle',
      'Vegetarian (VGML)', 'MIA', extensions.pgp_sym_encrypt('TEST000000', private.passport_number_key()), '0000',
      'US', '2031-04-30', 'DEMO CREW MEMBER')
    on conflict (id) do nothing;
    perform private.end_trusted_operation('passport_number_write');

    insert into app.person_emergency_contacts (id, person_id, full_name, relationship, phone_e164, email, sort_order)
    values (v_crew_contact, v_crew, 'Demo Emergency Contact', 'Partner', '+13055550123', 'contact@example.com', 0)
    on conflict (id) do nothing;

    insert into app.person_loyalty_programs (id, person_id, program_kind, program_name, member_number)
    values (v_program, v_crew, 'Airline', 'Demo Air Miles', 'DA-0000-TEST')
    on conflict (id) do nothing;
  end if;

  if exists (select 1 from app.people where id = v_owner) then
    insert into app.person_work_details (id, person_id, shirt_size, jacket_size, shoe_size, seat_preference, home_airport)
    values (v_owner_details, v_owner, 'M', 'M', 'US 9', 'Window', 'FLL')
    on conflict (id) do nothing;

    insert into app.person_emergency_contacts (id, person_id, full_name, relationship, phone_e164, sort_order)
    values (v_owner_contact, v_owner, 'Demo Owner Contact', 'Sibling', '+13055550188', 0)
    on conflict (id) do nothing;
  end if;

  if exists (select 1 from app.engagements where id = v_engagement and person_id = v_crew and deleted_at is null)
     and not exists (select 1 from app.work_detail_shares where id = v_share) then
    insert into app.consent_records (id, org_id, person_id, purpose_code, notice_version, source)
    values (v_consent, v_org, v_crew, 'work_details_sharing', '1.0.0', 'Web')
    on conflict (id) do nothing;
    insert into app.work_detail_shares (id, engagement_id, person_id, consent_record_id, categories)
    values (v_share, v_engagement, v_crew, v_consent, v_categories);
    perform private.log_work_detail_event(v_crew, 'work_details.shared', v_org, v_engagement, v_categories, '{}', null);
  end if;
end;
$$;
