-- 2655_roster_project_fact_rpcs.sql
-- R5 Project facts (RRR-184, ADR 0102; owner decisions 0/1, 3, 4 and 6). Who may enter and read the project facts of
-- 2654, the RPCs that do it, and how the facts leave.
--
-- Standing on an entry (private.project_fact_standing), first match wins:
--   * Person: the entry resolves to the caller (private.roster_entry_person, R4).
--   * Company: the caller manages the entry's roster (private.can_manage_roster, R4: the supplying account's Owners and
--     Admins, its live Advancing Leads, the engaged person, an artist's Advance representative, while the engagement is
--     open) and the entry is not Withdrawn. Account Finance and a duty Member have none (owner decision 6).
--   * Producer: the entry is Submitted, Accepted or Returned and the caller holds, on the engagement's project,
--     opportunities.engagement.read or a kind capability. A producer reads only the kinds its capabilities cover:
--     Travel by hospitality.fulfillment.read, Uniform by opportunities.engagement.read or crew.shift.write, Vehicle by
--     credentials.credential.read.
-- The person and the company write; the company only while advancing.company_may_submit_project_facts is on for the
-- project and only kinds the person has not entered (the person is then notified). Facts are asked only for offerings
-- the project turns on (private.project_fact_offered, the one caller of R3's resolver here).
-- Every read of a value by anyone other than the person writes the person's access log (company and producer) and the
-- producing org's audit ledger (producer), on every call, with no ten-minute merge.
-- The facts leave when the entry is withdrawn or declined, when the person's account is deleted, and keep_days
-- (advancing.project_facts.keep_days, default 90) after the engagement is Complete or Canceled, unless a legal hold
-- stands. Nothing is exported, searched, synced or published to Realtime; Compass never queues these writes (ADR 0071).

-- Helpers --------------------------------------------------------------------------------------------------------------

create or replace function private.project_fact_kind_capabilities(p_kind app.project_fact_kind)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'Travel' then array['hospitality.fulfillment.read']
    when 'Uniform' then array['opportunities.engagement.read', 'crew.shift.write']
    when 'Vehicle' then array['credentials.credential.read']
  end;
$$;

comment on function private.project_fact_kind_capabilities(app.project_fact_kind) is 'The project capabilities that let a producing-org member read a project fact kind (R5): Travel hospitality.fulfillment.read; Uniform opportunities.engagement.read or crew.shift.write; Vehicle credentials.credential.read.';

create or replace function private.project_fact_kind_offering(p_kind app.project_fact_kind)
returns app.offering_kind
language sql
immutable
set search_path = ''
as $$
  select case p_kind when 'Travel' then 'Travel' when 'Uniform' then 'Uniforms' when 'Vehicle' then 'Parking' end::app.offering_kind;
$$;

comment on function private.project_fact_kind_offering(app.project_fact_kind) is 'The offering that turns a project fact kind on (R5): Travel by Travel, Uniform by Uniforms, Vehicle by Parking.';

create or replace function private.can_read_project_fact_kind(p_project_id uuid, p_kind app.project_fact_kind)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from unnest(private.project_fact_kind_capabilities(p_kind)) c where private.can_on_project(p_project_id, c));
$$;

comment on function private.can_read_project_fact_kind(uuid, app.project_fact_kind) is 'True when the signed-in person holds, on the project, a capability that reads the project fact kind (private.project_fact_kind_capabilities).';

create or replace function private.project_fact_offered(p_engagement_id uuid, p_offering app.offering_kind)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.offering_mode(p_engagement_id, p_offering) <> 'Not Offered';
$$;

comment on function private.project_fact_offered(uuid, app.offering_kind) is 'True when the offering (Travel, Lodging, Uniforms or Parking) reaches the engagement in any mode but Not Offered (R3''s private.offering_mode). The only place R5 reads the resolver.';

create or replace function private.project_fact_entered_by_person(p_updated_by uuid, p_roster_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_updated_by is not null and p_updated_by = private.roster_entry_person(p_roster_entry_id);
$$;

comment on function private.project_fact_entered_by_person(uuid, uuid) is 'True when a project fact row was last written by the entry''s own person. Provenance is derived from the updated_by audit column and never stored.';

create or replace function private.project_fact_standing(p_roster_entry_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_entry app.engagement_roster_entries;
  v_project uuid;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
  select e.project_id into v_project from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_me is null or v_entry.id is null or v_project is null then
    return null;
  end if;
  if private.roster_entry_person(v_entry.id) = v_me then
    return 'Person';
  end if;
  if v_entry.entry_state <> 'Withdrawn' and private.can_manage_roster(v_entry.engagement_id) then
    return 'Company';
  end if;
  if v_entry.entry_state in ('Submitted', 'Accepted', 'Returned')
     and (private.can_on_project(v_project, 'opportunities.engagement.read')
       or exists (select 1 from unnest(enum_range(null::app.project_fact_kind)) k where private.can_read_project_fact_kind(v_project, k))) then
    return 'Producer';
  end if;
  return null;
end;
$$;

comment on function private.project_fact_standing(uuid) is 'The signed-in person''s standing on a roster entry''s project facts (R5): Person (the entry resolves to them), Company (they manage its roster, private.can_manage_roster, and it is not Withdrawn), Producer (it is Submitted, Accepted or Returned and they hold opportunities.engagement.read or a kind capability on the project), else NULL.';

create or replace function private.project_fact_updated_by(p_roster_entry_id uuid, p_kind app.project_fact_kind)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'Travel' then (select t.updated_by from app.roster_travel_requests t where t.roster_entry_id = p_roster_entry_id and t.deleted_at is null)
    when 'Uniform' then (select u.updated_by from app.roster_uniform_sizes u where u.roster_entry_id = p_roster_entry_id and u.deleted_at is null)
    when 'Vehicle' then (select v.updated_by from app.roster_vehicles v where v.roster_entry_id = p_roster_entry_id and v.deleted_at is null)
  end;
$$;

comment on function private.project_fact_updated_by(uuid, app.project_fact_kind) is 'Who last wrote the live row of a project fact kind on a roster entry; NULL when there is none.';

create or replace function private.assert_project_fact_writer(p_roster_entry_id uuid, p_kind app.project_fact_kind)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_standing text := private.project_fact_standing(p_roster_entry_id);
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_offering app.offering_kind := private.project_fact_kind_offering(p_kind);
begin
  if v_standing is null or v_standing not in ('Person', 'Company') then
    perform private.refuse('project_fact_not_yours', 'Only the person on the roster entry, or the company that rosters them, enters these details.');
  end if;
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id;
  if v_entry.entry_state = 'Withdrawn' then
    perform private.refuse('roster_entry_withdrawn', 'This roster entry was withdrawn.');
  end if;
  if v_entry.person_response = 'Declined' then
    perform private.refuse('roster_entry_declined', 'This roster entry was declined.');
  end if;
  if not private.engagement_shares_work_details(v_engagement.engagement_state) then
    perform private.refuse('project_fact_closed', 'This engagement is complete or canceled, so its project details are closed.');
  end if;
  if private.org_read_only(v_engagement.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so nothing more is entered for it.');
  end if;
  if not private.project_fact_offered(v_engagement.id, v_offering) then
    perform private.refuse('offering_not_offered', format('%s is not offered on this engagement''s project.', v_offering));
  end if;
  if v_standing = 'Company' then
    if not coalesce(private.setting_boolean(v_engagement.org_id, 'advancing.company_may_submit_project_facts', null,
        v_engagement.project_id), false) then
      perform private.refuse('project_fact_company_write_off', 'This project asks each person to enter their own details.');
    end if;
    if private.project_fact_entered_by_person(private.project_fact_updated_by(p_roster_entry_id, p_kind), p_roster_entry_id) then
      perform private.refuse('project_fact_person_entered', 'The person entered these details themselves, so only they change them.');
    end if;
  end if;
  return v_standing;
end;
$$;

comment on function private.assert_project_fact_writer(uuid, app.project_fact_kind) is 'Authorizes a write of a project fact kind on a roster entry and returns the standing (Person or Company). Refuses, in order: project_fact_not_yours, roster_entry_withdrawn, roster_entry_declined, project_fact_closed (the engagement is not Onboarding to Closing), org_read_only, offering_not_offered; and for the company project_fact_company_write_off (advancing.company_may_submit_project_facts is off for the project) and project_fact_person_entered (the live row is the person''s).';

create or replace function private.notify_project_facts_entered(p_roster_entry_id uuid, p_kind app.project_fact_kind)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.roster_entry_person(p_roster_entry_id);
  v_org uuid;
  v_project uuid;
  v_args jsonb;
begin
  select e.org_id, e.project_id into v_org, v_project
  from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id where r.id = p_roster_entry_id;
  v_args := private.roster_notification_args(p_roster_entry_id) || jsonb_build_object(
    'kind', lower(p_kind::text),
    'actorName', coalesce((select p.full_name from app.people p where p.id = private.current_person_id()), ''),
    'companyName', coalesce((select a.name from app.organizations a where a.id = private.roster_entry_account(p_roster_entry_id)), ''));
  begin
    perform private.notify(v_org, v_person, 'roster_entry.project_facts_entered', 'engagement_roster_entries', p_roster_entry_id,
      v_project, v_args);
  exception when others then
    raise warning 'roster_entry.project_facts_entered was not sent for roster entry %: %', p_roster_entry_id, sqlerrm;
  end;
end;
$$;

comment on function private.notify_project_facts_entered(uuid, app.project_fact_kind) is 'After the company enters a project fact kind for a person: sends roster_entry.project_facts_entered to the person with the kind (travel, uniform, vehicle), the acting person, company and project. A failure is a warning and never blocks the write (as 2050).';

-- Value objects ------------------------------------------------------------------------------------------------------------

create or replace function private.roster_travel_value(p_row app.roster_travel_requests)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_row.id is null then null else jsonb_build_object(
    'id', p_row.id,
    'inbound_airport_code', p_row.inbound_airport_code,
    'inbound_airport_name', (select a.name from app.airports a where a.iata_code = p_row.inbound_airport_code),
    'outbound_airport_code', p_row.outbound_airport_code,
    'outbound_airport_name', (select a.name from app.airports a where a.iata_code = p_row.outbound_airport_code),
    'inbound_on', p_row.inbound_on,
    'outbound_on', p_row.outbound_on,
    'seat_preference', p_row.seat_preference,
    'meal_preference', p_row.meal_preference,
    'needs_ground_transport', p_row.needs_ground_transport,
    'needs_lodging', p_row.needs_lodging,
    'travel_notes', p_row.travel_notes,
    'updated_at', p_row.updated_at) end;
$$;

comment on function private.roster_travel_value(app.roster_travel_requests) is 'The value object of a travel request, with the airport names from app.airports; NULL for no row.';

create or replace function private.roster_uniform_value(p_row app.roster_uniform_sizes)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_row.id is null then null else jsonb_build_object(
    'id', p_row.id,
    'shirt_size', p_row.shirt_size,
    'jacket_size', p_row.jacket_size,
    'pants_size', p_row.pants_size,
    'glove_size', p_row.glove_size,
    'hat_size', p_row.hat_size,
    'pants_waist_in', p_row.pants_waist_in,
    'pants_inseam_in', p_row.pants_inseam_in,
    'shoe_size', p_row.shoe_size,
    'shoe_size_system', p_row.shoe_size_system,
    'updated_at', p_row.updated_at) end;
$$;

comment on function private.roster_uniform_value(app.roster_uniform_sizes) is 'The value object of uniform sizes; NULL for no row.';

create or replace function private.roster_vehicle_value(p_row app.roster_vehicles)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_row.id is null then null else jsonb_build_object(
    'id', p_row.id,
    'make', p_row.make,
    'model', p_row.model,
    'color', p_row.color,
    'plate', p_row.plate,
    'plate_region', p_row.plate_region,
    'updated_at', p_row.updated_at) end;
$$;

comment on function private.roster_vehicle_value(app.roster_vehicles) is 'The value object of a vehicle; NULL for no row.';

-- Writes ---------------------------------------------------------------------------------------------------------------------

create or replace function private.project_fact_text(p_value text, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v is not null and char_length(v) > p_max then
    perform private.refuse('project_fact_text_length', format('Keep this to %s characters.', p_max));
  end if;
  return v;
end;
$$;

comment on function private.project_fact_text(text, integer) is 'A trimmed project fact text, NULL when blank; refuses project_fact_text_length above the limit.';

create or replace function app.save_roster_travel_request(
  p_roster_entry_id uuid,
  p_inbound_airport_code text,
  p_outbound_airport_code text,
  p_inbound_on date,
  p_outbound_on date,
  p_seat_preference app.seat_preference default null,
  p_meal_preference text default null,
  p_needs_ground_transport boolean default false,
  p_needs_lodging boolean default false,
  p_travel_notes text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_standing text;
  v_engagement uuid;
  v_in char(3) := nullif(upper(btrim(coalesce(p_inbound_airport_code, ''))), '');
  v_out char(3) := nullif(upper(btrim(coalesce(p_outbound_airport_code, ''))), '');
  v_meal text;
  v_notes text;
  v_id uuid;
begin
  perform private.require_person();
  v_standing := private.assert_project_fact_writer(p_roster_entry_id, 'Travel');
  select r.engagement_id into v_engagement from app.engagement_roster_entries r where r.id = p_roster_entry_id;
  if (v_in is not null and not exists (select 1 from app.airports a where a.iata_code = v_in and a.is_active))
     or (v_out is not null and not exists (select 1 from app.airports a where a.iata_code = v_out and a.is_active)) then
    perform private.refuse('airport_unknown', 'Choose an airport from the list.');
  end if;
  if p_inbound_on is not null and p_outbound_on is not null and p_outbound_on < p_inbound_on then
    perform private.refuse('travel_dates_order', 'The day you travel home comes on or after the day you arrive.');
  end if;
  if v_in is null and v_out is null and p_inbound_on is null and p_outbound_on is null then
    perform private.refuse('project_fact_empty', 'Give at least an airport or a date.');
  end if;
  if coalesce(p_needs_lodging, false) and not private.project_fact_offered(v_engagement, 'Lodging') then
    perform private.refuse('offering_not_offered', 'Lodging is not offered on this engagement''s project.');
  end if;
  v_meal := private.project_fact_text(p_meal_preference, 100);
  v_notes := private.project_fact_text(p_travel_notes, 500);

  select t.id into v_id from app.roster_travel_requests t where t.roster_entry_id = p_roster_entry_id and t.deleted_at is null for update;
  if v_id is null then
    insert into app.roster_travel_requests (roster_entry_id, inbound_airport_code, outbound_airport_code, inbound_on, outbound_on,
      seat_preference, meal_preference, needs_ground_transport, needs_lodging, travel_notes)
    values (p_roster_entry_id, v_in, v_out, p_inbound_on, p_outbound_on, p_seat_preference, v_meal,
      coalesce(p_needs_ground_transport, false), coalesce(p_needs_lodging, false), v_notes)
    returning id into v_id;
  else
    update app.roster_travel_requests set inbound_airport_code = v_in, outbound_airport_code = v_out, inbound_on = p_inbound_on,
      outbound_on = p_outbound_on, seat_preference = p_seat_preference, meal_preference = v_meal,
      needs_ground_transport = coalesce(p_needs_ground_transport, false), needs_lodging = coalesce(p_needs_lodging, false),
      travel_notes = v_notes
    where id = v_id;
  end if;
  if v_standing = 'Company' then
    perform private.notify_project_facts_entered(p_roster_entry_id, 'Travel');
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) is 'The person, or their company when the project allows it, saves the travel request of a roster entry as a full replacement of its live row (R5). Airport codes are uppercased. Refuses the writer rules of private.assert_project_fact_writer, airport_unknown, travel_dates_order, project_fact_empty, offering_not_offered (lodging asked while not offered) and project_fact_text_length. A company write notifies the person. Returns the row id.';

create or replace function app.save_roster_uniform_sizes(
  p_roster_entry_id uuid,
  p_shirt_size app.garment_letter_size,
  p_jacket_size app.garment_letter_size,
  p_pants_size app.garment_letter_size,
  p_glove_size app.garment_letter_size,
  p_hat_size app.garment_letter_size,
  p_pants_waist_in smallint,
  p_pants_inseam_in smallint,
  p_shoe_size numeric,
  p_shoe_size_system app.shoe_size_system
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_standing text;
  v_id uuid;
begin
  perform private.require_person();
  v_standing := private.assert_project_fact_writer(p_roster_entry_id, 'Uniform');
  if num_nonnulls(p_shirt_size, p_jacket_size, p_pants_size, p_glove_size, p_hat_size, p_pants_waist_in, p_pants_inseam_in,
      p_shoe_size) = 0 then
    perform private.refuse('project_fact_empty', 'Give at least one size.');
  end if;
  if p_shoe_size is not null and (p_shoe_size < 1 or p_shoe_size > 20 or p_shoe_size * 2 <> trunc(p_shoe_size * 2)) then
    perform private.refuse('shoe_size_format', 'A shoe size runs from 1 to 20 in half sizes.');
  end if;
  if (p_shoe_size is null) <> (p_shoe_size_system is null) then
    perform private.refuse('shoe_size_system_required', 'Give the shoe size with its sizing system.');
  end if;
  if (p_pants_waist_in is not null and p_pants_waist_in not between 20 and 70)
     or (p_pants_inseam_in is not null and p_pants_inseam_in not between 20 and 40) then
    perform private.refuse('pants_measure_range', 'A waist runs from 20 to 70 inches and an inseam from 20 to 40.');
  end if;

  select u.id into v_id from app.roster_uniform_sizes u where u.roster_entry_id = p_roster_entry_id and u.deleted_at is null for update;
  if v_id is null then
    insert into app.roster_uniform_sizes (roster_entry_id, shirt_size, jacket_size, pants_size, glove_size, hat_size,
      pants_waist_in, pants_inseam_in, shoe_size, shoe_size_system)
    values (p_roster_entry_id, p_shirt_size, p_jacket_size, p_pants_size, p_glove_size, p_hat_size, p_pants_waist_in,
      p_pants_inseam_in, p_shoe_size, p_shoe_size_system)
    returning id into v_id;
  else
    update app.roster_uniform_sizes set shirt_size = p_shirt_size, jacket_size = p_jacket_size, pants_size = p_pants_size,
      glove_size = p_glove_size, hat_size = p_hat_size, pants_waist_in = p_pants_waist_in, pants_inseam_in = p_pants_inseam_in,
      shoe_size = p_shoe_size, shoe_size_system = p_shoe_size_system
    where id = v_id;
  end if;
  if v_standing = 'Company' then
    perform private.notify_project_facts_entered(p_roster_entry_id, 'Uniform');
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_uniform_sizes(uuid, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, smallint, smallint, numeric, app.shoe_size_system) is 'The person, or their company when the project allows it, saves the uniform sizes of a roster entry as a full replacement of its live row (R5). Refuses the writer rules, project_fact_empty, shoe_size_format, shoe_size_system_required and pants_measure_range. A company write notifies the person. Returns the row id.';

create or replace function app.save_roster_vehicle(
  p_roster_entry_id uuid,
  p_make text,
  p_model text,
  p_color text,
  p_plate text,
  p_plate_region text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_standing text;
  v_make text;
  v_model text;
  v_color text;
  v_plate text := nullif(upper(regexp_replace(coalesce(p_plate, ''), '[\s-]', '', 'g')), '');
  v_region text := nullif(upper(btrim(coalesce(p_plate_region, ''))), '');
  v_id uuid;
begin
  perform private.require_person();
  v_standing := private.assert_project_fact_writer(p_roster_entry_id, 'Vehicle');
  v_make := private.project_fact_text(p_make, 60);
  v_model := private.project_fact_text(p_model, 60);
  v_color := private.project_fact_text(p_color, 30);
  if v_make is null or v_model is null or v_plate is null or v_region is null then
    perform private.refuse('vehicle_fields_required', 'Give the make, model, plate and the region that issued it.');
  end if;
  if v_plate !~ '^[A-Z0-9]{1,10}$' then
    perform private.refuse('plate_format', 'A plate is 1 to 10 letters and digits.');
  end if;
  if v_region !~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$' then
    perform private.refuse('plate_region_format', 'Give the region as a code such as US-FL, or the country code alone.');
  end if;

  select v.id into v_id from app.roster_vehicles v where v.roster_entry_id = p_roster_entry_id and v.deleted_at is null for update;
  if v_id is null then
    insert into app.roster_vehicles (roster_entry_id, make, model, color, plate, plate_region)
    values (p_roster_entry_id, v_make, v_model, v_color, v_plate, v_region)
    returning id into v_id;
  else
    update app.roster_vehicles set make = v_make, model = v_model, color = v_color, plate = v_plate, plate_region = v_region
    where id = v_id;
  end if;
  if v_standing = 'Company' then
    perform private.notify_project_facts_entered(p_roster_entry_id, 'Vehicle');
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_vehicle(uuid, text, text, text, text, text) is 'The person, or their company when the project allows it, saves the vehicle of a roster entry as a full replacement of its live row (R5). The plate is uppercased with spaces and hyphens removed. Refuses the writer rules, vehicle_fields_required, plate_format, plate_region_format and project_fact_text_length. A company write notifies the person. Returns the row id.';

create or replace function app.clear_roster_project_fact(p_roster_entry_id uuid, p_kind app.project_fact_kind)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_standing text;
begin
  perform private.require_person();
  if p_kind is null then
    perform private.refuse('project_fact_kind_required', 'Say which details to clear.');
  end if;
  v_standing := private.project_fact_standing(p_roster_entry_id);
  if v_standing is null or v_standing not in ('Person', 'Company') then
    perform private.refuse('project_fact_not_yours', 'Only the person on the roster entry, or the company that rosters them, clears these details.');
  end if;
  if v_standing = 'Company'
     and private.project_fact_entered_by_person(private.project_fact_updated_by(p_roster_entry_id, p_kind), p_roster_entry_id) then
    perform private.refuse('project_fact_person_entered', 'The person entered these details themselves, so only they change them.');
  end if;
  case p_kind
    when 'Travel' then
      update app.roster_travel_requests set deleted_at = now() where roster_entry_id = p_roster_entry_id and deleted_at is null;
    when 'Uniform' then
      update app.roster_uniform_sizes set deleted_at = now() where roster_entry_id = p_roster_entry_id and deleted_at is null;
    when 'Vehicle' then
      update app.roster_vehicles set deleted_at = now() where roster_entry_id = p_roster_entry_id and deleted_at is null;
  end case;
end;
$$;

comment on function app.clear_roster_project_fact(uuid, app.project_fact_kind) is 'Clears (soft-deletes) the live row of a project fact kind on a roster entry (R5). The person may clear at any time, also while the org is read-only or the engagement closed; the company only while it manages the roster and only rows the person did not enter (project_fact_person_entered). Nothing to clear is not an error.';

-- Reads ------------------------------------------------------------------------------------------------------------------------

create or replace function private.roster_project_facts_object(p_roster_entry_id uuid, p_standing text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_person uuid := private.roster_entry_person(p_roster_entry_id);
  v_travel app.roster_travel_requests;
  v_uniform app.roster_uniform_sizes;
  v_vehicle app.roster_vehicles;
  v_readable app.project_fact_kind[];
  v_logged app.project_fact_kind[];
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id;
  select * into v_travel from app.roster_travel_requests t where t.roster_entry_id = v_entry.id and t.deleted_at is null;
  select * into v_uniform from app.roster_uniform_sizes u where u.roster_entry_id = v_entry.id and u.deleted_at is null;
  select * into v_vehicle from app.roster_vehicles v where v.roster_entry_id = v_entry.id and v.deleted_at is null;

  if p_standing in ('Person', 'Company') then
    v_readable := enum_range(null::app.project_fact_kind);
  else
    select coalesce(array_agg(k order by k), '{}') into v_readable from unnest(enum_range(null::app.project_fact_kind)) k
    where private.can_read_project_fact_kind(v_engagement.project_id, k);
  end if;

  if p_standing in ('Company', 'Producer') then
    select coalesce(array_agg(k order by k), '{}') into v_logged from unnest(v_readable) k
    where (k = 'Travel' and v_travel.id is not null) or (k = 'Uniform' and v_uniform.id is not null)
       or (k = 'Vehicle' and v_vehicle.id is not null);
    if cardinality(v_logged) > 0 then
      perform private.log_project_fact_event(v_person, 'project_facts.viewed',
        case when p_standing = 'Company' then private.roster_entry_account(v_entry.id) else v_engagement.org_id end,
        v_engagement.id, v_entry.id, v_logged);
      if p_standing = 'Producer' then
        perform private.write_audit_event(v_engagement.org_id, 'project_facts.viewed', 'app.engagement_roster_entries', v_entry.id,
          jsonb_build_object('fact_kinds', to_jsonb(v_logged)));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'roster_entry_id', v_entry.id,
    'engagement_id', v_engagement.id,
    'org_id', v_engagement.org_id,
    'person_id', v_person,
    'standing', p_standing,
    'offered', jsonb_build_object(
      'travel', private.project_fact_offered(v_engagement.id, 'Travel'),
      'lodging', private.project_fact_offered(v_engagement.id, 'Lodging'),
      'uniforms', private.project_fact_offered(v_engagement.id, 'Uniforms'),
      'parking', private.project_fact_offered(v_engagement.id, 'Parking')),
    'present', jsonb_build_object('travel', v_travel.id is not null, 'uniform', v_uniform.id is not null,
      'vehicle', v_vehicle.id is not null),
    'entered_by_person', jsonb_build_object(
      'travel', private.project_fact_entered_by_person(v_travel.updated_by, v_entry.id),
      'uniform', private.project_fact_entered_by_person(v_uniform.updated_by, v_entry.id),
      'vehicle', private.project_fact_entered_by_person(v_vehicle.updated_by, v_entry.id)),
    'readable', to_jsonb(v_readable),
    'travel', case when 'Travel' = any (v_readable) then private.roster_travel_value(v_travel) end,
    'uniform', case when 'Uniform' = any (v_readable) then private.roster_uniform_value(v_uniform) end,
    'vehicle', case when 'Vehicle' = any (v_readable) then private.roster_vehicle_value(v_vehicle) end);
end;
$$;

comment on function private.roster_project_facts_object(uuid, text) is 'The project facts of a roster entry for a reader of the given standing, logging the read: for Company and Producer, when a readable kind has a row, one project_facts.viewed row in the person''s access log (org_id the supplying account or the producing org), and for Producer an audit event in the producing org. Callers check the standing first.';
revoke all on function private.roster_project_facts_object(uuid, text) from public, anon, authenticated;

create or replace function app.roster_project_facts(p_roster_entry_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_standing text;
begin
  perform private.require_person();
  v_standing := private.project_fact_standing(p_roster_entry_id);
  if v_standing is null then
    raise exception using errcode = '42501', message = 'the roster entry is not readable';
  end if;
  return private.roster_project_facts_object(p_roster_entry_id, v_standing);
end;
$$;

comment on function app.roster_project_facts(uuid) is 'The project facts of a roster entry (R5): roster_entry_id, engagement_id, org_id, person_id, the caller''s standing, which offerings are on, which kinds are present and entered by the person, the readable kinds and a value object per readable kind with a row. Person and Company read every kind; Producer reads the kinds its project capabilities cover. Every Company or Producer read of a value writes the person''s access log, and a Producer read the audit ledger. 42501 without standing.';

create or replace function app.roster_project_facts_for_engagement(p_engagement_id uuid)
returns setof jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
  v_standing text;
begin
  perform private.require_person();
  for v_entry in
    select r.id from app.engagement_roster_entries r
    where r.engagement_id = p_engagement_id and r.deleted_at is null
    order by r.is_self desc, r.created_at, r.id
  loop
    v_standing := private.project_fact_standing(v_entry);
    continue when v_standing is null;
    return next private.roster_project_facts_object(v_entry, v_standing);
  end loop;
end;
$$;

comment on function app.roster_project_facts_for_engagement(uuid) is 'The project facts of every live entry of an engagement on which the caller has standing, with the same shape and logging as app.roster_project_facts, one access-log row per entry returned with a readable value. The bulk read of the Gateway crew tab and Atlas Crew review.';

create or replace function app.roster_project_fact_status(p_engagement_id uuid)
returns table (
  roster_entry_id uuid,
  travel_offered boolean,
  lodging_offered boolean,
  uniforms_offered boolean,
  parking_offered boolean,
  has_travel boolean,
  has_uniform boolean,
  has_vehicle boolean,
  travel_entered_by_person boolean,
  uniform_entered_by_person boolean,
  vehicle_entered_by_person boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_travel boolean;
  v_lodging boolean;
  v_uniforms boolean;
  v_parking boolean;
begin
  perform private.require_person();
  v_travel := private.project_fact_offered(p_engagement_id, 'Travel');
  v_lodging := private.project_fact_offered(p_engagement_id, 'Lodging');
  v_uniforms := private.project_fact_offered(p_engagement_id, 'Uniforms');
  v_parking := private.project_fact_offered(p_engagement_id, 'Parking');
  return query
    select r.id, v_travel, v_lodging, v_uniforms, v_parking,
      t.id is not null, u.id is not null, v.id is not null,
      private.project_fact_entered_by_person(t.updated_by, r.id),
      private.project_fact_entered_by_person(u.updated_by, r.id),
      private.project_fact_entered_by_person(v.updated_by, r.id)
    from app.engagement_roster_entries r
    left join app.roster_travel_requests t on t.roster_entry_id = r.id and t.deleted_at is null
    left join app.roster_uniform_sizes u on u.roster_entry_id = r.id and u.deleted_at is null
    left join app.roster_vehicles v on v.roster_entry_id = r.id and v.deleted_at is null
    where r.engagement_id = p_engagement_id and r.deleted_at is null and private.project_fact_standing(r.id) is not null
    order by r.is_self desc, r.created_at, r.id;
end;
$$;

comment on function app.roster_project_fact_status(uuid) is 'Presence of project facts per live entry of an engagement on which the caller has standing (R5): which offerings are on, which kinds are on file and whether the person entered them. No value, so nothing is logged. Feeds the status chips of the Gateway crew tab and Atlas Crew review.';

create or replace function app.my_previous_roster_facts(p_kind app.project_fact_kind)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_travel app.roster_travel_requests;
  v_uniform app.roster_uniform_sizes;
  v_vehicle app.roster_vehicles;
begin
  case p_kind
    when 'Travel' then
      select t.* into v_travel from app.roster_travel_requests t
      where t.deleted_at is null and t.roster_entry_id in (select private.my_own_roster_entry_ids())
      order by t.updated_at desc, t.id desc limit 1;
      return private.roster_travel_value(v_travel) - 'id' - 'updated_at';
    when 'Uniform' then
      select u.* into v_uniform from app.roster_uniform_sizes u
      where u.deleted_at is null and u.roster_entry_id in (select private.my_own_roster_entry_ids())
      order by u.updated_at desc, u.id desc limit 1;
      return private.roster_uniform_value(v_uniform) - 'id' - 'updated_at';
    when 'Vehicle' then
      select v.* into v_vehicle from app.roster_vehicles v
      where v.deleted_at is null and v.roster_entry_id in (select private.my_own_roster_entry_ids())
      order by v.updated_at desc, v.id desc limit 1;
      return private.roster_vehicle_value(v_vehicle) - 'id' - 'updated_at';
    else
      return null;
  end case;
end;
$$;

comment on function app.my_previous_roster_facts(app.project_fact_kind) is 'The values of the caller''s most recently updated live project fact of a kind on any of their roster entries, or NULL (R5): an unsaved pre-fill for ''Use my last details''. Nothing once those facts have left.';

-- Erasure and exits ------------------------------------------------------------------------------------------------------------

create or replace function private.delete_roster_entry_project_facts(p_roster_entry_id uuid, p_action text)
returns app.project_fact_kind[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kinds app.project_fact_kind[] := '{}';
  v_count integer;
  v_person uuid := private.roster_entry_person(p_roster_entry_id);
  v_engagement uuid := (select r.engagement_id from app.engagement_roster_entries r where r.id = p_roster_entry_id);
begin
  perform private.begin_trusted_operation('project_facts_erase');
  delete from app.roster_travel_requests where roster_entry_id = p_roster_entry_id;
  get diagnostics v_count = row_count;
  if v_count > 0 then v_kinds := v_kinds || 'Travel'::app.project_fact_kind; end if;
  delete from app.roster_uniform_sizes where roster_entry_id = p_roster_entry_id;
  get diagnostics v_count = row_count;
  if v_count > 0 then v_kinds := v_kinds || 'Uniform'::app.project_fact_kind; end if;
  delete from app.roster_vehicles where roster_entry_id = p_roster_entry_id;
  get diagnostics v_count = row_count;
  if v_count > 0 then v_kinds := v_kinds || 'Vehicle'::app.project_fact_kind; end if;
  perform private.end_trusted_operation('project_facts_erase');
  if cardinality(v_kinds) > 0 and v_person is not null then
    perform private.log_project_fact_event(v_person, p_action, null, v_engagement, p_roster_entry_id, v_kinds);
  end if;
  return v_kinds;
end;
$$;

comment on function private.delete_roster_entry_project_facts(uuid, text) is 'Deletes every project fact row of a roster entry, live and cleared, inside the project_facts_erase trusted operation, and logs one event with the action given and the kinds deleted in the person''s access log. Returns the kinds.';
revoke all on function private.delete_roster_entry_project_facts(uuid, text) from public, anon, authenticated;

create or replace function private.erase_roster_project_facts_for_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
begin
  for v_entry in select p.roster_entry_id from private.roster_people p where p.person_id = new.id loop
    perform private.delete_roster_entry_project_facts(v_entry, 'project_facts.erased');
  end loop;
  return null;
end;
$$;

comment on function private.erase_roster_project_facts_for_person() is 'After a person is deleted (account deletion, 1112): deletes the project facts of every roster entry that resolves to them and logs project_facts.erased per entry. The access log stays; it holds no values.';
revoke all on function private.erase_roster_project_facts_for_person() from public, anon, authenticated;

create trigger t61_erase_roster_project_facts after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.erase_roster_project_facts_for_person();

create or replace function private.erase_roster_project_facts_on_exit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.entry_state = 'Withdrawn' and old.entry_state <> 'Withdrawn')
     or (new.person_response = 'Declined' and old.person_response <> 'Declined')
     or (new.deleted_at is not null and old.deleted_at is null) then
    perform private.delete_roster_entry_project_facts(new.id, 'project_facts.erased');
  end if;
  return null;
end;
$$;

comment on function private.erase_roster_project_facts_on_exit() is 'After a roster entry is withdrawn, declined by its person or deleted: deletes its project facts and logs project_facts.erased (R5).';
revoke all on function private.erase_roster_project_facts_on_exit() from public, anon, authenticated;

create trigger t86_erase_roster_project_facts after update on app.engagement_roster_entries
  for each row execute function private.erase_roster_project_facts_on_exit();

-- Expiry -------------------------------------------------------------------------------------------------------------------------

create or replace function private.expire_roster_project_facts()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_entries uuid[];
  v_kind app.project_fact_kind;
  v_deleted jsonb := '[]'::jsonb;
  v_total bigint := 0;
  v_row record;
begin
  foreach v_table in array array['roster_travel_requests', 'roster_uniform_sizes', 'roster_vehicles'] loop
    v_kind := private.project_fact_kind_of_table(v_table);
    begin
      perform private.begin_trusted_operation('retention_purge');
      execute format($q$
        with d as (
          delete from app.%I f
          using app.engagement_roster_entries r, app.engagements e
          where r.id = f.roster_entry_id and e.id = r.engagement_id
            and e.engagement_state in ('Complete', 'Canceled')
            and private.engagement_closed_at(e.id) < now()
              - make_interval(days => private.org_setting_integer(e.org_id, 'advancing.project_facts.keep_days')::integer)
            and e.org_id not in (select private.held_org_ids(%L))
          returning f.roster_entry_id)
        select coalesce(array_agg(d.roster_entry_id), '{}') from d$q$, v_table, 'app.' || v_table)
      into v_entries;
      perform private.end_trusted_operation('retention_purge');
      insert into private.retention_runs (table_name, action, rows_affected) values ('app.' || v_table, 'purge', cardinality(v_entries));
      v_total := v_total + cardinality(v_entries);
      v_deleted := v_deleted || coalesce((select jsonb_agg(jsonb_build_object('entry', x, 'kind', v_kind)) from unnest(v_entries) x), '[]'::jsonb);
    exception when others then
      insert into private.retention_runs (table_name, action, rows_affected, error_message)
      values ('app.' || v_table, 'purge', 0, sqlerrm);
    end;
  end loop;

  for v_row in
    select (d ->> 'entry')::uuid as entry, array_agg(distinct (d ->> 'kind')::app.project_fact_kind) as kinds
    from jsonb_array_elements(v_deleted) d group by 1
  loop
    if private.roster_entry_person(v_row.entry) is not null then
      perform private.log_project_fact_event(private.roster_entry_person(v_row.entry), 'project_facts.expired', null,
        (select r.engagement_id from app.engagement_roster_entries r where r.id = v_row.entry), v_row.entry,
        (select array_agg(k order by k) from unnest(v_row.kinds) k));
    end if;
  end loop;
  return v_total;
end;
$$;

comment on function private.expire_roster_project_facts() is 'The nightly job of R5: deletes the project facts of entries whose engagement has been Complete or Canceled for longer than the producing org''s advancing.project_facts.keep_days (default 90), skipping orgs under a legal hold on the table or on the whole org. Each table runs in its own subtransaction inside retention_purge and records its count, or its error, in private.retention_runs; one project_facts.expired event per entry names the kinds deleted. Returns the rows deleted.';
revoke all on function private.expire_roster_project_facts() from public, anon, authenticated;
grant execute on function private.expire_roster_project_facts() to service_role;

select cron.schedule('xos_expire_roster_project_facts', '29 3 * * *', 'select private.expire_roster_project_facts()');

-- Privileges -----------------------------------------------------------------------------------------------------------------------

revoke all on function private.project_fact_kind_capabilities(app.project_fact_kind) from public, anon, authenticated;
revoke all on function private.project_fact_kind_offering(app.project_fact_kind) from public, anon, authenticated;
revoke all on function private.can_read_project_fact_kind(uuid, app.project_fact_kind) from public, anon, authenticated;
revoke all on function private.project_fact_offered(uuid, app.offering_kind) from public, anon, authenticated;
revoke all on function private.project_fact_entered_by_person(uuid, uuid) from public, anon, authenticated;
revoke all on function private.project_fact_standing(uuid) from public, anon, authenticated;
revoke all on function private.assert_project_fact_writer(uuid, app.project_fact_kind) from public, anon, authenticated;
revoke all on function private.project_fact_updated_by(uuid, app.project_fact_kind) from public, anon, authenticated;
revoke all on function private.notify_project_facts_entered(uuid, app.project_fact_kind) from public, anon, authenticated;
revoke all on function private.roster_travel_value(app.roster_travel_requests) from public, anon, authenticated;
revoke all on function private.roster_uniform_value(app.roster_uniform_sizes) from public, anon, authenticated;
revoke all on function private.roster_vehicle_value(app.roster_vehicles) from public, anon, authenticated;
revoke all on function private.project_fact_text(text, integer) from public, anon, authenticated;

revoke all on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) from public, anon;
revoke all on function app.save_roster_uniform_sizes(uuid, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, smallint, smallint, numeric, app.shoe_size_system) from public, anon;
revoke all on function app.save_roster_vehicle(uuid, text, text, text, text, text) from public, anon;
revoke all on function app.clear_roster_project_fact(uuid, app.project_fact_kind) from public, anon;
revoke all on function app.roster_project_facts(uuid) from public, anon;
revoke all on function app.roster_project_facts_for_engagement(uuid) from public, anon;
revoke all on function app.roster_project_fact_status(uuid) from public, anon;
revoke all on function app.my_previous_roster_facts(app.project_fact_kind) from public, anon;
grant execute on function app.save_roster_travel_request(uuid, text, text, date, date, app.seat_preference, text, boolean, boolean, text) to authenticated, service_role;
grant execute on function app.save_roster_uniform_sizes(uuid, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, app.garment_letter_size, smallint, smallint, numeric, app.shoe_size_system) to authenticated, service_role;
grant execute on function app.save_roster_vehicle(uuid, text, text, text, text, text) to authenticated, service_role;
grant execute on function app.clear_roster_project_fact(uuid, app.project_fact_kind) to authenticated, service_role;
grant execute on function app.roster_project_facts(uuid) to authenticated, service_role;
grant execute on function app.roster_project_facts_for_engagement(uuid) to authenticated, service_role;
grant execute on function app.roster_project_fact_status(uuid) to authenticated, service_role;
grant execute on function app.my_previous_roster_facts(app.project_fact_kind) to authenticated, service_role;
