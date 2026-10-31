-- 2654_roster_project_facts.sql
-- R5 Project facts (RRR-184, ADR 0102; owner decisions 0/1, 3, 4 and 6). The facts a rostered person enters for one
-- project on their own roster entry: a travel request, uniform sizes and a vehicle. They live on the entry, never on
-- the profile, so nothing here is copied to app.person_work_details and nothing outlives the engagement (2655 deletes
-- them keep_days after it closes).
--
--   * One live row per entry and kind. org_id is the producing org, derived from the entry; the person is the entry's
--     resolved person (private.roster_entry_person, R4), never stored. Who entered a row is updated_by, compared with
--     the person in 2655 (provenance is derived, 3NF).
--   * Only the person selects the rows directly. Every other read goes through the logged RPCs of 2655, and every
--     write through the save and clear RPCs: insert and update are revoked from authenticated.
--   * Every value column is Confidential and no AI feature reads these tables (Section 14.3).
--   * app.work_detail_events, the person's access log (1340), gains fact_kinds; roster_entry_id is R4's (2638).
--   * The person clears their facts whenever they like, also while the org is read-only, so the tables are read-only
--     exempt; the save RPCs refuse new values with org_read_only themselves.
--   * A cleared row is not restorable from Trash: the person removed it, and only they or the company re-enter it.

-- Read-only exemption, before the tables, so the tenant guards install no read-only trigger (as 1340) ------------------

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.roster_travel_requests', 'The person clears their project facts at any time; the save RPCs refuse new values with a read-only org.'),
  ('app.roster_uniform_sizes', 'The person clears their project facts at any time; the save RPCs refuse new values with a read-only org.'),
  ('app.roster_vehicles', 'The person clears their project facts at any time; the save RPCs refuse new values with a read-only org.');

-- Enums ----------------------------------------------------------------------------------------------------------------

create type app.project_fact_kind as enum ('Travel', 'Uniform', 'Vehicle');
comment on type app.project_fact_kind is 'Kinds of project facts a rostered person enters on their roster entry (R5, ADR 0102): the travel request, uniform sizes and vehicle. Each is asked only while its offering (Travel, Uniforms, Parking) is on.';

create type app.shoe_size_system as enum ('US Men', 'US Women', 'EU', 'UK');
comment on type app.shoe_size_system is 'Sizing system of a shoe size on a roster entry''s uniform sizes.';

-- Travel request ---------------------------------------------------------------------------------------------------------

create table app.roster_travel_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  roster_entry_id uuid not null references app.engagement_roster_entries (id),
  inbound_airport_code char(3) references app.airports (iata_code),
  outbound_airport_code char(3) references app.airports (iata_code),
  inbound_on date,
  outbound_on date,
  seat_preference app.seat_preference,
  meal_preference text,
  needs_ground_transport boolean not null default false,
  needs_lodging boolean not null default false,
  travel_notes text,
  deleted_at timestamptz,
  constraint roster_travel_requests_dates_order check (outbound_on is null or inbound_on is null or outbound_on >= inbound_on),
  constraint roster_travel_requests_not_empty check (inbound_airport_code is not null or outbound_airport_code is not null
    or inbound_on is not null or outbound_on is not null),
  constraint roster_travel_requests_meal_length check (meal_preference is null or char_length(btrim(meal_preference)) between 1 and 100),
  constraint roster_travel_requests_notes_length check (travel_notes is null or char_length(btrim(travel_notes)) between 1 and 500)
);

create index roster_travel_requests_roster_entry_id_idx on app.roster_travel_requests (roster_entry_id);
create index roster_travel_requests_inbound_airport_code_idx on app.roster_travel_requests (inbound_airport_code);
create index roster_travel_requests_outbound_airport_code_idx on app.roster_travel_requests (outbound_airport_code);
create unique index roster_travel_requests_live_key on app.roster_travel_requests (roster_entry_id) where deleted_at is null;

call private.install_domain_table('app.roster_travel_requests', 'app.engagement_roster_entries', 'roster_entry_id');
call private.describe('app.roster_travel_requests', 'The travel a rostered person asks for on one project (R5, ADR 0102): airports, dates, seat and meal preference, and whether they need ground transport or lodging. Entered by the person, or by the company that rosters them when the org allows it; never copied to the profile. Read by others only through app.roster_project_facts, which logs each read.', array[
  'roster_entry_id', 'Roster entry the request belongs to; the person is the entry''s resolved person.',
  'inbound_airport_code', 'IATA code of the airport the person flies into for the project; NULL when not yet known.',
  'outbound_airport_code', 'Airport the person flies home from; NULL when not yet known.',
  'inbound_on', 'Date the person travels to the project.',
  'outbound_on', 'Date the person travels home; never before inbound_on.',
  'seat_preference', 'Preferred seat; NULL for no answer.',
  'meal_preference', 'Meal preference for the flight, as the person writes it.',
  'needs_ground_transport', 'True when the person needs a pickup on arrival.',
  'needs_lodging', 'True when the person needs a room; asked only while lodging is offered.',
  'travel_notes', 'Anything else the travel desk should know, as the person writes it.'
]);

-- Uniform sizes ----------------------------------------------------------------------------------------------------------

create table app.roster_uniform_sizes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  roster_entry_id uuid not null references app.engagement_roster_entries (id),
  shirt_size app.garment_letter_size,
  jacket_size app.garment_letter_size,
  pants_size app.garment_letter_size,
  glove_size app.garment_letter_size,
  hat_size app.garment_letter_size,
  pants_waist_in smallint,
  pants_inseam_in smallint,
  shoe_size numeric(3, 1),
  shoe_size_system app.shoe_size_system,
  deleted_at timestamptz,
  constraint roster_uniform_sizes_waist_range check (pants_waist_in is null or pants_waist_in between 20 and 70),
  constraint roster_uniform_sizes_inseam_range check (pants_inseam_in is null or pants_inseam_in between 20 and 40),
  constraint roster_uniform_sizes_shoe_format check (shoe_size is null or (shoe_size between 1 and 20 and shoe_size * 2 = trunc(shoe_size * 2))),
  constraint roster_uniform_sizes_shoe_pair check ((shoe_size is null) = (shoe_size_system is null)),
  constraint roster_uniform_sizes_not_empty check (num_nonnulls(shirt_size, jacket_size, pants_size, glove_size, hat_size,
    pants_waist_in, pants_inseam_in, shoe_size) > 0)
);

create index roster_uniform_sizes_roster_entry_id_idx on app.roster_uniform_sizes (roster_entry_id);
create unique index roster_uniform_sizes_live_key on app.roster_uniform_sizes (roster_entry_id) where deleted_at is null;

call private.install_domain_table('app.roster_uniform_sizes', 'app.engagement_roster_entries', 'roster_entry_id');
call private.describe('app.roster_uniform_sizes', 'The uniform sizes a rostered person gives for one project (R5, ADR 0102). Letter sizes and measures only, no free text. Read by others only through app.roster_project_facts, which logs each read.', array[
  'roster_entry_id', 'Roster entry the sizes belong to; the person is the entry''s resolved person.',
  'shirt_size', 'Shirt letter size.',
  'jacket_size', 'Jacket letter size.',
  'pants_size', 'Pants letter size.',
  'glove_size', 'Glove letter size.',
  'hat_size', 'Hat letter size.',
  'pants_waist_in', 'Pants waist in whole inches, 20 to 70.',
  'pants_inseam_in', 'Pants inseam in whole inches, 20 to 40.',
  'shoe_size', 'Shoe size, 1 to 20 in half sizes, in shoe_size_system.',
  'shoe_size_system', 'Sizing system of shoe_size; set exactly when shoe_size is.'
]);

-- Vehicle ----------------------------------------------------------------------------------------------------------------

create table app.roster_vehicles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  roster_entry_id uuid not null references app.engagement_roster_entries (id),
  make text not null,
  model text not null,
  color text,
  plate text not null,
  plate_region text not null,
  deleted_at timestamptz,
  constraint roster_vehicles_make_length check (char_length(btrim(make)) between 1 and 60),
  constraint roster_vehicles_model_length check (char_length(btrim(model)) between 1 and 60),
  constraint roster_vehicles_color_length check (color is null or char_length(btrim(color)) between 1 and 30),
  constraint roster_vehicles_plate_format check (plate ~ '^[A-Z0-9]{1,10}$'),
  constraint roster_vehicles_plate_region_format check (plate_region ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$')
);

create index roster_vehicles_roster_entry_id_idx on app.roster_vehicles (roster_entry_id);
create unique index roster_vehicles_live_key on app.roster_vehicles (roster_entry_id) where deleted_at is null;

call private.install_domain_table('app.roster_vehicles', 'app.engagement_roster_entries', 'roster_entry_id');
call private.describe('app.roster_vehicles', 'The vehicle a rostered person brings to one project (R5, ADR 0102), for parking and credentials. Read by others only through app.roster_project_facts, which logs each read.', array[
  'roster_entry_id', 'Roster entry the vehicle belongs to; the person is the entry''s resolved person.',
  'make', 'Vehicle make, for example Ford.',
  'model', 'Vehicle model, for example Transit.',
  'color', 'Vehicle color, as the person writes it.',
  'plate', 'License plate, uppercase letters and digits without spaces or hyphens.',
  'plate_region', 'ISO 3166-2 code of the region that issued the plate, for example US-FL, or the country code alone.'
]);

-- Classification, AI exclusion, retention and Trash ------------------------------------------------------------------------

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.roster_travel_requests', 'inbound_airport_code', 'Confidential', null),
  ('app.roster_travel_requests', 'outbound_airport_code', 'Confidential', null),
  ('app.roster_travel_requests', 'inbound_on', 'Confidential', null),
  ('app.roster_travel_requests', 'outbound_on', 'Confidential', null),
  ('app.roster_travel_requests', 'seat_preference', 'Confidential', null),
  ('app.roster_travel_requests', 'meal_preference', 'Confidential', null),
  ('app.roster_travel_requests', 'needs_ground_transport', 'Confidential', null),
  ('app.roster_travel_requests', 'needs_lodging', 'Confidential', null),
  ('app.roster_travel_requests', 'travel_notes', 'Confidential', null),
  ('app.roster_uniform_sizes', 'shirt_size', 'Confidential', null),
  ('app.roster_uniform_sizes', 'jacket_size', 'Confidential', null),
  ('app.roster_uniform_sizes', 'pants_size', 'Confidential', null),
  ('app.roster_uniform_sizes', 'glove_size', 'Confidential', null),
  ('app.roster_uniform_sizes', 'hat_size', 'Confidential', null),
  ('app.roster_uniform_sizes', 'pants_waist_in', 'Confidential', null),
  ('app.roster_uniform_sizes', 'pants_inseam_in', 'Confidential', null),
  ('app.roster_uniform_sizes', 'shoe_size', 'Confidential', null),
  ('app.roster_uniform_sizes', 'shoe_size_system', 'Confidential', null),
  ('app.roster_vehicles', 'make', 'Confidential', null),
  ('app.roster_vehicles', 'model', 'Confidential', null),
  ('app.roster_vehicles', 'color', 'Confidential', null),
  ('app.roster_vehicles', 'plate', 'Confidential', null),
  ('app.roster_vehicles', 'plate_region', 'Confidential', null);

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.roster_travel_requests', 'A person''s travel plans for one project, shared only with the people the roster allows (R5, Section 14.3).'),
  ('app.roster_uniform_sizes', 'A person''s body measurements for one project (R5, Section 14.3).'),
  ('app.roster_vehicles', 'A person''s vehicle and plate for one project (R5, Section 14.3).');

-- Rows the person or the company cleared leave after 30 days; the close-based deletion is the job in 2655.
call private.install_default_retention('app.roster_travel_requests', interval '30 days');
call private.install_default_retention('app.roster_uniform_sizes', interval '30 days');
call private.install_default_retention('app.roster_vehicles', interval '30 days');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('roster_travel_requests', 'A cleared project fact is entered again by the person or their company, never restored by someone else.'),
  ('roster_uniform_sizes', 'A cleared project fact is entered again by the person or their company, never restored by someone else.'),
  ('roster_vehicles', 'A cleared project fact is entered again by the person or their company, never restored by someone else.')
on conflict (table_name) do nothing;

-- Reads: the person only ---------------------------------------------------------------------------------------------------

create or replace function private.my_own_roster_entry_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.roster_entry_id from private.roster_people p
  join app.engagement_roster_entries r on r.id = p.roster_entry_id and r.deleted_at is null
  where p.person_id = private.current_person_id();
$$;

comment on function private.my_own_roster_entry_ids() is 'The live roster entries that resolve to the signed-in person (private.roster_people, R4), whatever their state: the rows whose project facts they read directly.';
revoke all on function private.my_own_roster_entry_ids() from public, anon;
grant execute on function private.my_own_roster_entry_ids() to authenticated, service_role;

call private.install_policies('app.roster_travel_requests', $$roster_entry_id in (select private.my_own_roster_entry_ids())$$);
call private.install_policies('app.roster_uniform_sizes', $$roster_entry_id in (select private.my_own_roster_entry_ids())$$);
call private.install_policies('app.roster_vehicles', $$roster_entry_id in (select private.my_own_roster_entry_ids())$$);
revoke insert, update on app.roster_travel_requests, app.roster_uniform_sizes, app.roster_vehicles from authenticated;

-- The access log -------------------------------------------------------------------------------------------------------------

alter table app.work_detail_events add column fact_kinds app.project_fact_kind[] not null default '{}';
comment on column app.work_detail_events.fact_kinds is 'Project fact kinds an act covered (R5): Travel, Uniform or Vehicle, for project_facts.* events and changes to the roster fact tables.';

create or replace function private.log_project_fact_event(
  p_person_id uuid,
  p_action text,
  p_org_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_fact_kinds app.project_fact_kind[],
  p_changed_columns text[] default '{}'
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into app.work_detail_events (person_id, actor_person_id, org_id, engagement_id, action, changed_columns, request_id,
    roster_entry_id, fact_kinds)
  values (p_person_id, private.current_person_id(), p_org_id, p_engagement_id, p_action, coalesce(p_changed_columns, '{}'),
    left(private.request_header('x-request-id'), 200), p_roster_entry_id, coalesce(p_fact_kinds, '{}'));
end;
$$;

comment on function private.log_project_fact_event(uuid, text, uuid, uuid, uuid, app.project_fact_kind[], text[]) is 'Writes one row to the person''s access log (app.work_detail_events) for their project facts: the act, the kinds and changed column names, never a value, with the acting person and request id from the session.';
revoke all on function private.log_project_fact_event(uuid, text, uuid, uuid, uuid, app.project_fact_kind[], text[]) from public, anon, authenticated;

create or replace function private.project_fact_kind_of_table(p_table text)
returns app.project_fact_kind
language sql
immutable
set search_path = ''
as $$
  select case p_table
    when 'roster_travel_requests' then 'Travel'
    when 'roster_uniform_sizes' then 'Uniform'
    when 'roster_vehicles' then 'Vehicle'
  end::app.project_fact_kind;
$$;

comment on function private.project_fact_kind_of_table(text) is 'The project fact kind a roster fact table holds, by table name.';
revoke all on function private.project_fact_kind_of_table(text) from public, anon, authenticated;

create or replace function private.log_project_fact_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_skip text[] := array['id', 'org_id', 'roster_entry_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at'];
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := to_jsonb(new);
  v_changed text[];
  v_verb text := lower(tg_op);
  v_person uuid := private.roster_entry_person(new.roster_entry_id);
  v_actor uuid := private.current_person_id();
  v_engagement uuid;
begin
  if private.in_trusted_operation('project_facts_erase') or private.in_trusted_operation('retention_purge') or v_person is null then
    return null;
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(v_new) k
  where k <> all (v_skip) and (v_new -> k) is distinct from (v_old -> k)
    and (tg_op = 'UPDATE' or (v_new -> k) not in ('null'::jsonb, 'false'::jsonb));
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    v_verb := 'delete';
    v_changed := '{}';
  elsif tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;
  end if;
  select r.engagement_id into v_engagement from app.engagement_roster_entries r where r.id = new.roster_entry_id;
  perform private.log_project_fact_event(v_person, tg_table_name || '.' || v_verb,
    case when v_actor is null or v_actor = v_person then null else private.roster_entry_account(new.roster_entry_id) end,
    v_engagement, new.roster_entry_id, array[private.project_fact_kind_of_table(tg_table_name)], v_changed);
  return null;
end;
$$;

comment on function private.log_project_fact_change() is 'After insert or update on the roster fact tables (R5): logs the change to the person''s access log with the names of the changed columns, never their values. A soft delete logs as delete. org_id is NULL when the person acted and the supplying account (private.roster_entry_account) when their company did. Skipped inside project_facts_erase and retention_purge, which log for themselves.';
revoke all on function private.log_project_fact_change() from public, anon, authenticated;

create trigger t85_log_project_fact_change after insert or update on app.roster_travel_requests
  for each row execute function private.log_project_fact_change();
create trigger t85_log_project_fact_change after insert or update on app.roster_uniform_sizes
  for each row execute function private.log_project_fact_change();
create trigger t85_log_project_fact_change after insert or update on app.roster_vehicles
  for each row execute function private.log_project_fact_change();

select private.sync_trash_tables();
