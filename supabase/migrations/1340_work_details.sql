-- 1340_work_details.sql
-- A78 Work Details and people formats (RRR-123, WP4), findings A65-003 and A65-028 (names). Section 4.5.6 personal
-- setting 10 holds "emergency contacts, uniform sizes, dietary and accessibility needs for hospitality (sensitive;
-- shared per engagement only with consent), travel profile (loyalty programs, seating; passport details stored as
-- Restricted)". Section 4.3 item 13 puts the emergency contact and uniform sizes on the Compass profile and Section
-- 4.4.4 lists them in the crew onboarding packet. Nothing stored them.
--
--   * Person-owned tables (install_person_table: owner-only reads and writes, no hard delete):
--       app.person_work_details        one row per person: uniform sizes, dietary needs and allergies, accessibility
--                                      needs, and the travel profile (seat and meal preference, home airport, passport)
--       app.person_emergency_contacts  several, in the owner's order, phones in E.164 (Section 15), at most five
--       app.person_loyalty_programs    airline, hotel, car rental and rail memberships, at most twenty
--   * The passport number is Restricted (Section 8.3, government identifier) and field-encrypted with pgcrypto under
--     its own Vault key (Section 9), following the tax identifier pattern (0730, 1200): nobody signed in can select
--     or write the ciphertext; it is written only through app.set_my_passport_number and leaves only through an
--     explicit, audited reveal (app.reveal_my_passport_number for the owner, app.reveal_shared_passport_number for an
--     engaging org). Every other read path shows its last four characters with the number masked. The issuing
--     country, expiry and name as printed are Confidential, not encrypted: they identify nobody on their own and the
--     expiry has to stay readable for reminders.
--   * Sharing is per engagement and per category (app.work_detail_category), under a work_details_sharing consent
--     record for the engaging org (Section 14.3). app.share_work_details records or changes the categories,
--     app.revoke_work_detail_share revokes at once, and the consent is withdrawn when the org's last live share
--     goes. An engaging org reads what was shared only through app.shared_work_details, only while the share
--     stands and the engagement is Onboarding, Blocked, Active or Closing, and only the categories its reader's
--     project capabilities cover (private.work_detail_category_capabilities): safety readers for emergency
--     contacts, engagement managers for uniform sizes, hospitality for dietary, accessibility, travel and passport.
--   * Everything is audited. Owner changes, shares, revocations, org reads and reveals land in
--     app.work_detail_events, the person's own access log, with the categories and changed column names but never a
--     value. Org reads, reveals and share changes also land in the org's audit ledger (app.audit_events).
--   * Account deletion (1112) erases the person's work details: a trigger on app.people deletes the rows, revokes
--     live shares and withdraws the consents when the person is deleted.
--   * Section 15 names: app.people gains optional given_name and family_name beside full_name. The full name stays
--     what the person gave; nothing assumes a first-last order.
-- Policy helpers take column values and never re-read the table their policy protects (ADR 0016 item 14).

-- Enums -----------------------------------------------------------------------------------------------------------------

create type app.work_detail_category as enum (
  'Emergency Contacts', 'Uniform Sizes', 'Dietary Needs', 'Accessibility Needs', 'Travel Profile', 'Passport'
);
comment on type app.work_detail_category is 'Categories of a person''s work details that are shared with an engaging org one by one (Section 4.5.6 item 10). Travel Profile is seat and meal preference, home airport and loyalty programs; Passport is the passport details, kept separate so travel preferences can be shared without them.';

create type app.garment_letter_size as enum ('XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL');
comment on type app.garment_letter_size is 'Letter sizes for shirts, jackets and gloves, smallest first.';

create type app.dietary_need as enum (
  'Vegetarian', 'Vegan', 'Pescatarian', 'Halal', 'Kosher', 'Gluten Free', 'Dairy Free', 'Nut Free', 'Shellfish Free'
);
comment on type app.dietary_need is 'Dietary needs hospitality caters for. Allergies are written out in person_work_details.allergies.';

create type app.accessibility_need as enum (
  'Step-Free Access', 'Accessible Parking', 'Accessible Restroom', 'Seating', 'Sign Language Interpreter',
  'Captioning', 'Large Print', 'Service Animal', 'Quiet Space', 'Assistance on Arrival'
);
comment on type app.accessibility_need is 'Accessibility needs a person asks an engaging org to plan for.';

create type app.seat_preference as enum ('Window', 'Aisle', 'No Preference');
comment on type app.seat_preference is 'Preferred seat when an org books travel.';

create type app.loyalty_program_kind as enum ('Airline', 'Hotel', 'Car Rental', 'Rail');
comment on type app.loyalty_program_kind is 'Kind of travel loyalty program.';

insert into private.consent_purposes (code, lawful_basis, sort_order) values ('work_details_sharing', 'consent', 60);

-- Withdrawing consent stays possible while an org is canceled and read-only (Section 14.7): consent is withdrawn as
-- easily as it was given (GDPR Article 7(3)). The access log records permitted acts, like the audit ledger.
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.consent_records', 'A person withdraws consent at any time, also while the org is read-only (GDPR Article 7(3)).'),
  ('app.work_detail_shares', 'A person revokes a work details share at any time; new shares with a read-only org are refused by the RPC.'),
  ('app.work_detail_events', 'The work details access log records permitted acts, like the audit ledger.');
drop trigger if exists t15_refuse_read_only_org on app.consent_records;

-- Section 15 names ---------------------------------------------------------------------------------------------------------

alter table app.people
  add column given_name text,
  add column family_name text,
  add constraint people_given_name_length check (given_name is null or char_length(btrim(given_name)) between 1 and 100),
  add constraint people_family_name_length check (family_name is null or char_length(btrim(family_name)) between 1 and 100);

comment on column app.people.given_name is 'Optional given name, as the person writes it (Section 15). Used for formal address and sorting, never to rebuild the full name.';
comment on column app.people.family_name is 'Optional family name, as the person writes it (Section 15). Sorting uses it when present; the platform never assumes it comes last.';

grant update (given_name, family_name) on app.people to authenticated;

-- Passport key ---------------------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'xos_passport_number_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_passport_number_key',
      'Symmetric key that encrypts passport numbers on app.person_work_details (Sections 8.3, 9 and 14.3).');
  end if;
end $$;

create or replace function private.passport_number_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_passport_number_key';
$$;

comment on function private.passport_number_key() is 'The Vault key that encrypts passport numbers. Never granted to signed-in callers.';
revoke all on function private.passport_number_key() from public, anon, authenticated;

-- Work details -----------------------------------------------------------------------------------------------------------------

create table app.person_work_details (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  shirt_size app.garment_letter_size,
  jacket_size app.garment_letter_size,
  pants_size text,
  shoe_size text,
  glove_size app.garment_letter_size,
  hat_size text,
  uniform_notes text,
  dietary_needs app.dietary_need[] not null default '{}',
  allergies text,
  dietary_notes text,
  accessibility_needs app.accessibility_need[] not null default '{}',
  accessibility_notes text,
  seat_preference app.seat_preference,
  meal_preference text,
  home_airport char(3),
  passport_number bytea,
  passport_number_last4 text,
  passport_issuing_country char(2),
  passport_expires_on date,
  passport_name text,
  constraint person_work_details_pants_size check (pants_size is null or char_length(btrim(pants_size)) between 1 and 20),
  constraint person_work_details_shoe_size check (shoe_size is null or char_length(btrim(shoe_size)) between 1 and 20),
  constraint person_work_details_hat_size check (hat_size is null or char_length(btrim(hat_size)) between 1 and 20),
  constraint person_work_details_uniform_notes check (uniform_notes is null or char_length(btrim(uniform_notes)) between 1 and 500),
  constraint person_work_details_allergies check (allergies is null or char_length(btrim(allergies)) between 1 and 500),
  constraint person_work_details_dietary_notes check (dietary_notes is null or char_length(btrim(dietary_notes)) between 1 and 500),
  constraint person_work_details_accessibility_notes check (accessibility_notes is null or char_length(btrim(accessibility_notes)) between 1 and 1000),
  constraint person_work_details_meal_preference check (meal_preference is null or char_length(btrim(meal_preference)) between 1 and 100),
  constraint person_work_details_home_airport check (home_airport is null or home_airport ~ '^[A-Z]{3}$'),
  constraint person_work_details_passport_last4 check (passport_number_last4 is null or passport_number_last4 ~ '^[0-9A-Z]{1,4}$'),
  constraint person_work_details_passport_pair check ((passport_number is null) = (passport_number_last4 is null)),
  constraint person_work_details_passport_country check (passport_issuing_country is null or passport_issuing_country ~ '^[A-Z]{2}$'),
  constraint person_work_details_passport_name check (passport_name is null or char_length(btrim(passport_name)) between 1 and 200)
);

create unique index person_work_details_person_key on app.person_work_details (person_id) where deleted_at is null;

call private.install_person_table('app.person_work_details');
call private.describe('app.person_work_details', 'A person''s work details (Section 4.5.6 item 10): uniform sizes, dietary and accessibility needs and the travel profile. Owned and read only by the person; an engaging org sees a category only while the person shares it with that engagement (app.work_detail_shares, app.shared_work_details). The passport number is Restricted and encrypted.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner. One live row per person.',
  'shirt_size', 'Shirt size.',
  'jacket_size', 'Jacket size.',
  'pants_size', 'Pants size as the person writes it, for example 32x32 or EU 48.',
  'shoe_size', 'Shoe size with its system, for example US 10.5 or EU 44.',
  'glove_size', 'Glove size.',
  'hat_size', 'Hat size as the person writes it, for example 7 1/4 or 58 cm.',
  'uniform_notes', 'Anything else about fit, for example a preferred cut.',
  'dietary_needs', 'Dietary needs hospitality caters for, each once, in enum order. Confidential.',
  'allergies', 'Food and other allergies in the person''s words, with how severe they are. Confidential.',
  'dietary_notes', 'Other dietary notes. Confidential.',
  'accessibility_needs', 'Accessibility needs, each once, in enum order. Confidential.',
  'accessibility_notes', 'Accessibility needs in the person''s words. Confidential.',
  'seat_preference', 'Preferred seat when an org books travel.',
  'meal_preference', 'Preferred in-flight meal, for example Vegetarian (VGML).',
  'home_airport', 'IATA code of the airport the person travels from, for example MIA.',
  'passport_number', 'Passport number encrypted with pgp_sym_encrypt under the Vault key xos_passport_number_key. Restricted (data.restricted.read.government_id): never selectable or writable by signed-in callers; written through app.set_my_passport_number and read only through an audited reveal.',
  'passport_number_last4', 'Last four characters of the passport number, shown in place of the masked number; NULL when none is recorded. Set only with the number.',
  'passport_issuing_country', 'ISO 3166-1 alpha-2 country that issued the passport. Confidential.',
  'passport_expires_on', 'Day the passport expires. Confidential; readable so reminders can run.',
  'passport_name', 'Name exactly as printed in the passport, which travel bookings must match. Confidential.'
]);

-- The ciphertext is never selectable or writable; its last four are written only with it.
revoke select, insert, update on app.person_work_details from authenticated;
grant select (id, person_id, shirt_size, jacket_size, pants_size, shoe_size, glove_size, hat_size, uniform_notes,
  dietary_needs, allergies, dietary_notes, accessibility_needs, accessibility_notes, seat_preference, meal_preference,
  home_airport, passport_number_last4, passport_issuing_country, passport_expires_on, passport_name,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.person_work_details to authenticated;
grant insert (person_id, shirt_size, jacket_size, pants_size, shoe_size, glove_size, hat_size, uniform_notes,
  dietary_needs, allergies, dietary_notes, accessibility_needs, accessibility_notes, seat_preference, meal_preference,
  home_airport, passport_issuing_country, passport_expires_on, passport_name) on app.person_work_details to authenticated;
grant update (shirt_size, jacket_size, pants_size, shoe_size, glove_size, hat_size, uniform_notes,
  dietary_needs, allergies, dietary_notes, accessibility_needs, accessibility_notes, seat_preference, meal_preference,
  home_airport, passport_issuing_country, passport_expires_on, passport_name, deleted_at) on app.person_work_details to authenticated;

call private.install_default_retention('app.person_work_details', interval '90 days');

create or replace function private.guard_person_work_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and (new.passport_number is not null or new.passport_number_last4 is not null))
     or (tg_op = 'UPDATE' and (new.passport_number is distinct from old.passport_number
                               or new.passport_number_last4 is distinct from old.passport_number_last4)) then
    if not private.in_trusted_operation('passport_number_write') then
      perform private.refuse('passport_number_rpc_only', 'A passport number is written only through app.set_my_passport_number, which encrypts it.');
    end if;
  end if;
  -- Each need once, in enum order, so a diff shows a real change.
  new.dietary_needs := coalesce((select array_agg(distinct d order by d) from unnest(new.dietary_needs) d), '{}');
  new.accessibility_needs := coalesce((select array_agg(distinct a order by a) from unnest(new.accessibility_needs) a), '{}');
  return new;
end;
$$;

comment on function private.guard_person_work_details() is 'Person work details: the passport number and its last four change only inside the encrypting RPC; dietary and accessibility needs are kept once each, in enum order.';
revoke all on function private.guard_person_work_details() from public, anon, authenticated;

create trigger t40_guard_person_work_details before insert or update on app.person_work_details
  for each row execute function private.guard_person_work_details();

-- Emergency contacts ---------------------------------------------------------------------------------------------------------------

create table app.person_emergency_contacts (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  full_name text not null,
  relationship text,
  phone_e164 text not null,
  alternate_phone_e164 text,
  email text,
  sort_order smallint not null default 0,
  constraint person_emergency_contacts_full_name check (char_length(btrim(full_name)) between 1 and 200),
  constraint person_emergency_contacts_relationship check (relationship is null or char_length(btrim(relationship)) between 1 and 60),
  constraint person_emergency_contacts_phone check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint person_emergency_contacts_alternate_phone check (alternate_phone_e164 is null or alternate_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  constraint person_emergency_contacts_email check (email is null or (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320)),
  constraint person_emergency_contacts_sort_order check (sort_order between 0 and 99)
);

call private.install_person_table('app.person_emergency_contacts');
call private.describe('app.person_emergency_contacts', 'People to call when something happens to the person on site (Section 4.5.6 item 10, Section 4.3 item 13), in the owner''s order, at most five live. Owned and read only by the person; shared with an engagement under the Emergency Contacts category.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner.',
  'full_name', 'Contact''s name as the person writes it. Confidential.',
  'relationship', 'How the contact relates to the person, for example Partner or Sister.',
  'phone_e164', 'Contact''s phone in E.164, for example +13055550142 (Section 15). Shown in national or international format. Confidential.',
  'alternate_phone_e164', 'A second phone in E.164. Confidential.',
  'email', 'Contact''s email address. Confidential.',
  'sort_order', 'Order to call in, lowest first.'
]);
call private.install_default_retention('app.person_emergency_contacts', interval '90 days');

-- Loyalty programs -----------------------------------------------------------------------------------------------------------------

create table app.person_loyalty_programs (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  program_kind app.loyalty_program_kind not null,
  program_name text not null,
  member_number text not null,
  sort_order smallint not null default 0,
  constraint person_loyalty_programs_name check (char_length(btrim(program_name)) between 1 and 100),
  constraint person_loyalty_programs_member_number check (char_length(btrim(member_number)) between 1 and 40),
  constraint person_loyalty_programs_sort_order check (sort_order between 0 and 99)
);

create unique index person_loyalty_programs_key on app.person_loyalty_programs (person_id, program_kind, lower(btrim(program_name)))
  where deleted_at is null;

call private.install_person_table('app.person_loyalty_programs');
call private.describe('app.person_loyalty_programs', 'Travel loyalty programs a person belongs to (Section 4.5.6 item 10, travel profile), at most twenty live. Shared with an engagement under the Travel Profile category.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner.',
  'program_kind', 'Airline, Hotel, Car Rental or Rail.',
  'program_name', 'Program, for example SkyMiles. Once per kind per person.',
  'member_number', 'Membership number. Confidential.',
  'sort_order', 'Display order.'
]);
call private.install_default_retention('app.person_loyalty_programs', interval '90 days');

create or replace function private.limit_live_person_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := tg_argv[0]::integer;
  v_count integer;
begin
  if new.deleted_at is not null or (tg_op = 'UPDATE' and old.deleted_at is null) then
    return new;
  end if;
  execute format('select count(*) from %I.%I t where t.person_id = $1 and t.deleted_at is null and t.id <> $2',
    tg_table_schema, tg_table_name) into v_count using new.person_id, new.id;
  if v_count >= v_limit then
    perform private.refuse(tg_argv[1], format('Keep at most %s; remove one first.', v_limit));
  end if;
  return new;
end;
$$;

comment on function private.limit_live_person_rows() is 'Before insert or restore: refuses a person-owned row beyond the live limit given as the first trigger argument, with the rule given as the second.';
revoke all on function private.limit_live_person_rows() from public, anon, authenticated;

create trigger t41_limit_emergency_contacts before insert or update of deleted_at on app.person_emergency_contacts
  for each row execute function private.limit_live_person_rows('5', 'emergency_contact_limit');
create trigger t41_limit_loyalty_programs before insert or update of deleted_at on app.person_loyalty_programs
  for each row execute function private.limit_live_person_rows('20', 'loyalty_program_limit');

-- Classification ---------------------------------------------------------------------------------------------------------------------

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.person_work_details', 'passport_number', 'Restricted', 'data.restricted.read.government_id'),
  ('app.person_work_details', 'passport_number_last4', 'Confidential', null),
  ('app.person_work_details', 'passport_issuing_country', 'Confidential', null),
  ('app.person_work_details', 'passport_expires_on', 'Confidential', null),
  ('app.person_work_details', 'passport_name', 'Confidential', null),
  ('app.person_work_details', 'dietary_needs', 'Confidential', null),
  ('app.person_work_details', 'allergies', 'Confidential', null),
  ('app.person_work_details', 'dietary_notes', 'Confidential', null),
  ('app.person_work_details', 'accessibility_needs', 'Confidential', null),
  ('app.person_work_details', 'accessibility_notes', 'Confidential', null),
  ('app.person_emergency_contacts', 'full_name', 'Confidential', null),
  ('app.person_emergency_contacts', 'phone_e164', 'Confidential', null),
  ('app.person_emergency_contacts', 'alternate_phone_e164', 'Confidential', null),
  ('app.person_emergency_contacts', 'email', 'Confidential', null),
  ('app.person_loyalty_programs', 'member_number', 'Confidential', null);

-- Allergies and accessibility needs are health data: no AI feature reads these tables at all (Section 14.3).
insert into private.ai_excluded_tables (table_name, reason) values
  ('app.person_work_details', 'Work details hold allergies, accessibility needs and passport details (Section 14.3).'),
  ('app.person_emergency_contacts', 'Emergency contacts are third parties'' personal data shared only for safety (Section 14.3).');

-- Access log ---------------------------------------------------------------------------------------------------------------------------

create table app.work_detail_events (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  actor_person_id uuid references app.people (id),
  org_id uuid references app.organizations (id),
  engagement_id uuid references app.engagements (id),
  action text not null,
  categories app.work_detail_category[] not null default '{}',
  changed_columns text[] not null default '{}',
  reason text,
  request_id text,
  created_at timestamptz not null default now(),
  constraint work_detail_events_action_format check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint work_detail_events_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 500),
  constraint work_detail_events_request_id_length check (request_id is null or char_length(request_id) <= 200)
);

create index work_detail_events_person_created_idx on app.work_detail_events (person_id, created_at);
create index work_detail_events_actor_person_id_idx on app.work_detail_events (actor_person_id);
create index work_detail_events_org_id_idx on app.work_detail_events (org_id);
create index work_detail_events_engagement_id_idx on app.work_detail_events (engagement_id);

call private.describe('app.work_detail_events', 'The person''s own access log for their work details (Section 8.4 access transparency): every change they make, every share and revocation, and every read or reveal by an engaging org, with the categories and changed column names but never a value. Written only by the database; the person reads all of theirs and an org''s audit readers read the rows naming their org.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person whose work details were touched.',
  'actor_person_id', 'Person who acted; NULL for the database or a service.',
  'org_id', 'Org whose member acted or whose share changed; NULL for the owner''s own changes.',
  'engagement_id', 'Engagement the share serves, for share, read and reveal events.',
  'action', 'What happened, as subject.verb: for example person_work_details.update, work_details.shared, work_details.viewed or passport.revealed.',
  'categories', 'Categories the act covered.',
  'changed_columns', 'Columns an owner change touched, never their values.',
  'reason', 'Reason an org member gave for revealing the passport number.',
  'request_id', 'API request id, for correlating with logs.',
  'created_at', 'When it happened. Set by the database.'
]);

alter table app.work_detail_events enable row level security;
revoke all on app.work_detail_events from public, anon, authenticated;
grant select on app.work_detail_events to authenticated;
grant all on app.work_detail_events to service_role;
create policy work_detail_events_read on app.work_detail_events for select to authenticated
  using (person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('audit.log.read')));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.work_detail_events', 'Age', 'created_at', interval '7 years', 'Delete', 'Access log kept as long as the audit ledger; it holds no values.');

create or replace function private.log_work_detail_event(
  p_person_id uuid,
  p_action text,
  p_org_id uuid default null,
  p_engagement_id uuid default null,
  p_categories app.work_detail_category[] default '{}',
  p_changed_columns text[] default '{}',
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into app.work_detail_events (person_id, actor_person_id, org_id, engagement_id, action, categories, changed_columns,
    reason, request_id)
  values (p_person_id, private.current_person_id(), p_org_id, p_engagement_id, p_action, coalesce(p_categories, '{}'),
    coalesce(p_changed_columns, '{}'), nullif(btrim(p_reason), ''), left(private.request_header('x-request-id'), 200));
end;
$$;

comment on function private.log_work_detail_event(uuid, text, uuid, uuid, app.work_detail_category[], text[], text) is 'Writes one row to the person''s work details access log, with the acting person and request id from the session.';
revoke all on function private.log_work_detail_event(uuid, text, uuid, uuid, app.work_detail_category[], text[], text) from public, anon, authenticated;

create or replace function private.log_work_detail_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_skip text[] := array['id', 'person_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'passport_number', 'passport_number_last4'];
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := to_jsonb(new);
  v_changed text[];
  v_verb text := lower(tg_op);
begin
  if private.in_trusted_operation('work_details_erase') then
    return null;
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_changed
  from jsonb_object_keys(v_new) k
  where k <> all (v_skip) and (v_new -> k) is distinct from (v_old -> k)
    and (tg_op = 'UPDATE' or (v_new -> k) not in ('null'::jsonb, '[]'::jsonb));
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    v_verb := 'delete';
    v_changed := '{}';
  elsif tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;
  end if;
  perform private.log_work_detail_event(new.person_id, tg_table_name || '.' || v_verb, null, null, '{}', v_changed, null);
  return null;
end;
$$;

comment on function private.log_work_detail_change() is 'After insert or update on the person-owned work detail tables: logs the change to app.work_detail_events with the names of the changed columns, never their values. A soft delete is logged as delete; the passport number is logged by its own RPC.';
revoke all on function private.log_work_detail_change() from public, anon, authenticated;

create trigger t85_log_work_detail_change after insert or update on app.person_work_details
  for each row execute function private.log_work_detail_change();
create trigger t85_log_work_detail_change after insert or update on app.person_emergency_contacts
  for each row execute function private.log_work_detail_change();
create trigger t85_log_work_detail_change after insert or update on app.person_loyalty_programs
  for each row execute function private.log_work_detail_change();

-- Owner RPCs -------------------------------------------------------------------------------------------------------------------------------

create or replace function app.ensure_my_work_details()
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_id uuid;
begin
  select w.id into v_id from app.person_work_details w where w.person_id = v_me and w.deleted_at is null;
  if v_id is null then
    insert into app.person_work_details (person_id) values (v_me) returning id into v_id;
  end if;
  return v_id;
end;
$$;

comment on function app.ensure_my_work_details() is 'Returns the signed-in person''s work details row, creating an empty one the first time.';

create or replace function app.set_my_passport_number(p_passport_number text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_clean text := upper(regexp_replace(coalesce(p_passport_number, ''), '[^0-9A-Za-z]', '', 'g'));
  v_id uuid;
begin
  if p_passport_number is not null and (char_length(v_clean) < 5 or char_length(v_clean) > 20) then
    perform private.refuse('passport_number_format', 'A passport number has 5 to 20 letters and digits.');
  end if;
  v_id := app.ensure_my_work_details();
  perform private.begin_trusted_operation('passport_number_write');
  update app.person_work_details w set
    passport_number = case when p_passport_number is null then null
                           else extensions.pgp_sym_encrypt(v_clean, private.passport_number_key()) end,
    passport_number_last4 = case when p_passport_number is null then null else right(v_clean, 4) end
  where w.id = v_id;
  perform private.end_trusted_operation('passport_number_write');
  perform private.log_work_detail_event(v_me,
    case when p_passport_number is null then 'passport.number_cleared' else 'passport.number_set' end,
    null, null, array['Passport']::app.work_detail_category[], array['passport_number'], null);
end;
$$;

comment on function app.set_my_passport_number(text) is 'Sets or clears (NULL) the signed-in person''s passport number: keeps letters and digits, encrypts them under the Vault key and stores the last four. The access log records that it changed, never the value.';

create or replace function app.reveal_my_passport_number()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_cipher bytea;
begin
  select w.passport_number into v_cipher from app.person_work_details w where w.person_id = v_me and w.deleted_at is null;
  if v_cipher is null then
    perform private.refuse('passport_number_missing', 'No passport number is recorded.');
  end if;
  perform private.log_work_detail_event(v_me, 'passport.revealed', null, null, array['Passport']::app.work_detail_category[], '{}', null);
  return extensions.pgp_sym_decrypt(v_cipher, private.passport_number_key());
end;
$$;

comment on function app.reveal_my_passport_number() is 'The explicit reveal of the signed-in person''s own passport number. Every call is written to their access log.';

-- Sharing -----------------------------------------------------------------------------------------------------------------------------------

create table app.work_detail_shares (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  person_id uuid not null references app.people (id),
  consent_record_id uuid not null references app.consent_records (id),
  categories app.work_detail_category[] not null,
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint work_detail_shares_categories check (cardinality(categories) between 1 and 6),
  constraint work_detail_shares_revoked_after check (revoked_at is null or revoked_at >= shared_at)
);

create index work_detail_shares_engagement_id_idx on app.work_detail_shares (engagement_id);
create index work_detail_shares_person_id_idx on app.work_detail_shares (person_id);
create index work_detail_shares_consent_record_id_idx on app.work_detail_shares (consent_record_id);

call private.install_domain_table('app.work_detail_shares', 'app.engagements', 'engagement_id', array['app.consent_records', 'consent_record_id']);
call private.describe('app.work_detail_shares', 'A person''s consent to share chosen categories of their work details with the org that engages them, for one engagement (Section 4.5.6 item 10, Section 14.3). Written only by app.share_work_details and app.revoke_work_detail_share; one live share per engagement. The org reads what was shared through app.shared_work_details while the share stands and the engagement is open.', array[
  'engagement_id', 'Engagement the share serves.',
  'person_id', 'Person sharing, the engagement''s party.',
  'consent_record_id', 'The work_details_sharing consent record for the org.',
  'categories', 'Categories shared, each once, in enum order.',
  'shared_at', 'When the share was given.',
  'revoked_at', 'When the person revoked it; NULL while it stands.'
]);

create unique index work_detail_shares_live_key on app.work_detail_shares (engagement_id) where revoked_at is null and deleted_at is null;

create or replace function private.work_detail_category_capabilities(p_category app.work_detail_category)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_category
    when 'Emergency Contacts' then array['safety.incident.read', 'opportunities.engagement.write']
    when 'Uniform Sizes' then array['opportunities.engagement.read', 'crew.shift.write']
    else array['hospitality.fulfillment.read']
  end;
$$;

comment on function private.work_detail_category_capabilities(app.work_detail_category) is 'Project capabilities that let a member of the engaging org read a shared category, any one of them: safety readers and engagement editors for emergency contacts; engagement readers and shift editors for uniform sizes; hospitality readers for dietary and accessibility needs, the travel profile and the passport details.';
revoke all on function private.work_detail_category_capabilities(app.work_detail_category) from public, anon;
grant execute on function private.work_detail_category_capabilities(app.work_detail_category) to authenticated, service_role;

create or replace function private.can_read_work_detail_category(p_project_id uuid, p_category app.work_detail_category)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from unnest(private.work_detail_category_capabilities(p_category)) c
    where private.can_on_project(p_project_id, c));
$$;

comment on function private.can_read_work_detail_category(uuid, app.work_detail_category) is 'True when the signed-in person holds, on the project, one of the capabilities that read the category.';
revoke all on function private.can_read_work_detail_category(uuid, app.work_detail_category) from public, anon;
grant execute on function private.can_read_work_detail_category(uuid, app.work_detail_category) to authenticated, service_role;

create or replace function private.work_detail_share_visible(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    where e.id = p_engagement_id
      and (private.can_on_project(e.project_id, 'opportunities.engagement.read')
        or exists (select 1 from unnest(enum_range(null::app.work_detail_category)) c
                   where private.can_read_work_detail_category(e.project_id, c))));
$$;

comment on function private.work_detail_share_visible(uuid) is 'True when a member of the engaging org may see that a share exists and which categories it names: engagement readers and anyone who reads one of the categories on the engagement''s project. Reads app.engagements, never the share table its caller protects.';
revoke all on function private.work_detail_share_visible(uuid) from public, anon;
grant execute on function private.work_detail_share_visible(uuid) to authenticated, service_role;

call private.install_policies('app.work_detail_shares',
  $$person_id = (select private.current_person_id()) or private.work_detail_share_visible(engagement_id)$$);
revoke insert, update on app.work_detail_shares from authenticated;
call private.install_default_retention('app.work_detail_shares');
call private.install_audit_trail('app.work_detail_shares');

create or replace function private.engagement_shares_work_details(p_state app.engagement_state)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_state in ('Onboarding', 'Blocked', 'Active', 'Closing');
$$;

comment on function private.engagement_shares_work_details(app.engagement_state) is 'Engagement states in which work details can be shared and read: from onboarding until close-out ends. Complete and Canceled close every share.';
revoke all on function private.engagement_shares_work_details(app.engagement_state) from public, anon;
grant execute on function private.engagement_shares_work_details(app.engagement_state) to authenticated, service_role;

create or replace function app.share_work_details(
  p_engagement_id uuid,
  p_categories app.work_detail_category[],
  p_notice_version text default '1.0.0'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_engagement app.engagements;
  v_categories app.work_detail_category[] := (select array_agg(distinct c order by c) from unnest(p_categories) c where c is not null);
  v_share app.work_detail_shares;
  v_consent uuid;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or v_engagement.person_id is distinct from v_me then
    perform private.refuse('work_detail_share_not_yours', 'Only the person an engagement names shares their work details with it.');
  end if;
  if not private.engagement_shares_work_details(v_engagement.engagement_state) then
    perform private.refuse('work_detail_share_closed', 'This engagement is complete or canceled, so nothing more is shared with it.');
  end if;
  if private.org_read_only(v_engagement.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only, so nothing more is shared with it.');
  end if;
  if coalesce(cardinality(v_categories), 0) = 0 then
    perform private.refuse('work_detail_share_categories', 'Choose at least one category to share, or revoke the share.');
  end if;

  select * into v_share from app.work_detail_shares s
  where s.engagement_id = v_engagement.id and s.revoked_at is null and s.deleted_at is null;

  if v_share.id is not null then
    if v_share.categories = v_categories then
      return v_share.id;
    end if;
    update app.work_detail_shares s set categories = v_categories where s.id = v_share.id;
    perform private.log_work_detail_event(v_me, 'work_details.share_changed', v_engagement.org_id, v_engagement.id, v_categories, '{}', null);
    return v_share.id;
  end if;

  select r.id into v_consent from app.consent_records r
  where r.org_id = v_engagement.org_id and r.person_id = v_me and r.purpose_code = 'work_details_sharing'
    and r.withdrawn_at is null and r.deleted_at is null;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (v_engagement.org_id, v_me, 'work_details_sharing', coalesce(nullif(btrim(p_notice_version), ''), '1.0.0'), 'Web')
    returning id into v_consent;
  end if;
  insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories)
  values (v_engagement.id, v_me, v_consent, v_categories)
  returning * into v_share;
  perform private.log_work_detail_event(v_me, 'work_details.shared', v_engagement.org_id, v_engagement.id, v_categories, '{}', null);
  return v_share.id;
end;
$$;

comment on function app.share_work_details(uuid, app.work_detail_category[], text) is 'The person an engagement names shares chosen categories of their work details with it, recording work_details_sharing consent for the org when none stands; a second call replaces the categories (fewer is a partial revocation). Refused once the engagement is Complete or Canceled. Returns the share id.';

create or replace function private.close_work_detail_share(p_share app.work_detail_shares, p_action text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.work_detail_shares s set revoked_at = now() where s.id = p_share.id and s.revoked_at is null;
  -- The consent ends with the org's last live share.
  if not exists (select 1 from app.work_detail_shares s
                 where s.consent_record_id = p_share.consent_record_id and s.revoked_at is null and s.deleted_at is null) then
    update app.consent_records r set withdrawn_at = now() where r.id = p_share.consent_record_id and r.withdrawn_at is null;
  end if;
  perform private.log_work_detail_event(p_share.person_id, p_action, p_share.org_id, p_share.engagement_id, p_share.categories, '{}', null);
end;
$$;

comment on function private.close_work_detail_share(app.work_detail_shares, text) is 'Revokes a live share, withdraws the org''s work_details_sharing consent when no other live share uses it, and logs the act.';
revoke all on function private.close_work_detail_share(app.work_detail_shares, text) from public, anon, authenticated;

create or replace function app.revoke_work_detail_share(p_work_detail_share_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_share app.work_detail_shares;
begin
  select * into v_share from app.work_detail_shares s
  where s.id = p_work_detail_share_id and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null or v_share.person_id <> v_me then
    perform private.refuse('work_detail_share_not_yours', 'Only the person who gave a live share revokes it.');
  end if;
  perform private.close_work_detail_share(v_share, 'work_details.share_revoked');
end;
$$;

comment on function app.revoke_work_detail_share(uuid) is 'The person revokes a work details share at once; the org reads nothing more, and the org''s consent is withdrawn when it was the last live share.';

create or replace function app.my_work_detail_sharing()
returns table (
  engagement_id uuid,
  org_id uuid,
  org_name text,
  project_name text,
  role_type app.external_role_type,
  engagement_state app.engagement_state,
  start_date date,
  end_date date,
  sharing_open boolean,
  work_detail_share_id uuid,
  categories app.work_detail_category[],
  shared_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.org_id, o.name, p.name, e.role_type, e.engagement_state, e.start_date, e.end_date,
    private.engagement_shares_work_details(e.engagement_state),
    s.id, coalesce(s.categories, '{}'), s.shared_at
  from app.engagements e
  join app.organizations o on o.id = e.org_id
  join app.projects p on p.id = e.project_id
  left join app.work_detail_shares s on s.engagement_id = e.id and s.revoked_at is null and s.deleted_at is null
  where e.person_id = private.current_person_id() and e.deleted_at is null
  order by private.engagement_shares_work_details(e.engagement_state) desc, e.start_date desc, e.id;
$$;

comment on function app.my_work_detail_sharing() is 'The signed-in person''s engagements with what each shares of their work details: the org, project, state, whether sharing is open (Onboarding to Closing) and the live share''s categories. Open engagements first, newest first.';

-- Org reads ------------------------------------------------------------------------------------------------------------------------------------

create or replace function private.work_details_view_logged_recently(p_share_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.work_detail_events v
    where v.person_id = p_person_id and v.action = 'work_details.viewed'
      and v.actor_person_id = private.current_person_id()
      and v.engagement_id = (select s.engagement_id from app.work_detail_shares s where s.id = p_share_id)
      and v.created_at > now() - interval '10 minutes');
$$;

comment on function private.work_details_view_logged_recently(uuid, uuid) is 'True when the signed-in member''s read of a share was logged in the last ten minutes, so repeated page loads log one view.';
revoke all on function private.work_details_view_logged_recently(uuid, uuid) from public, anon, authenticated;

create or replace function app.shared_work_details(p_engagement_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_share app.work_detail_shares;
  v_details app.person_work_details;
  v_readable app.work_detail_category[];
  v_result jsonb;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.work_detail_share_visible(v_engagement.id) then
    raise exception using errcode = '42501', message = 'the engagement is not readable';
  end if;
  select * into v_share from app.work_detail_shares s
  where s.engagement_id = v_engagement.id and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null or not private.engagement_shares_work_details(v_engagement.engagement_state) then
    return jsonb_build_object('engagement_id', v_engagement.id, 'person_id', v_engagement.person_id,
      'org_id', v_engagement.org_id, 'work_detail_share_id', null, 'shared_at', null,
      'categories', '[]'::jsonb, 'readable', '[]'::jsonb, 'sharing_open', private.engagement_shares_work_details(v_engagement.engagement_state),
      'emergency_contacts', null, 'uniform', null, 'dietary', null, 'accessibility', null, 'travel', null, 'passport', null);
  end if;

  select coalesce(array_agg(c order by c), '{}') into v_readable from unnest(v_share.categories) c
  where private.can_read_work_detail_category(v_engagement.project_id, c);
  select * into v_details from app.person_work_details w where w.person_id = v_share.person_id and w.deleted_at is null;

  v_result := jsonb_build_object(
    'engagement_id', v_engagement.id,
    'person_id', v_share.person_id,
    'org_id', v_share.org_id,
    'work_detail_share_id', v_share.id,
    'shared_at', v_share.shared_at,
    'categories', to_jsonb(v_share.categories),
    'readable', to_jsonb(v_readable),
    'sharing_open', true,
    'emergency_contacts', case when 'Emergency Contacts' = any (v_readable) then coalesce((
      select jsonb_agg(jsonb_build_object('full_name', c.full_name, 'relationship', c.relationship, 'phone_e164', c.phone_e164,
        'alternate_phone_e164', c.alternate_phone_e164, 'email', c.email, 'sort_order', c.sort_order) order by c.sort_order, c.created_at)
      from app.person_emergency_contacts c where c.person_id = v_share.person_id and c.deleted_at is null), '[]'::jsonb) end,
    'uniform', case when 'Uniform Sizes' = any (v_readable) then jsonb_build_object(
      'shirt_size', v_details.shirt_size, 'jacket_size', v_details.jacket_size, 'pants_size', v_details.pants_size,
      'shoe_size', v_details.shoe_size, 'glove_size', v_details.glove_size, 'hat_size', v_details.hat_size,
      'uniform_notes', v_details.uniform_notes) end,
    'dietary', case when 'Dietary Needs' = any (v_readable) then jsonb_build_object(
      'dietary_needs', to_jsonb(coalesce(v_details.dietary_needs, '{}')), 'allergies', v_details.allergies,
      'dietary_notes', v_details.dietary_notes) end,
    'accessibility', case when 'Accessibility Needs' = any (v_readable) then jsonb_build_object(
      'accessibility_needs', to_jsonb(coalesce(v_details.accessibility_needs, '{}')),
      'accessibility_notes', v_details.accessibility_notes) end,
    'travel', case when 'Travel Profile' = any (v_readable) then jsonb_build_object(
      'seat_preference', v_details.seat_preference, 'meal_preference', v_details.meal_preference,
      'home_airport', v_details.home_airport,
      'loyalty_programs', coalesce((
        select jsonb_agg(jsonb_build_object('program_kind', l.program_kind, 'program_name', l.program_name,
          'member_number', l.member_number) order by l.sort_order, l.program_kind, l.program_name)
        from app.person_loyalty_programs l where l.person_id = v_share.person_id and l.deleted_at is null), '[]'::jsonb)) end,
    'passport', case when 'Passport' = any (v_readable) then jsonb_build_object(
      'passport_number', null,
      'passport_number_last4', v_details.passport_number_last4,
      'passport_number_masked', v_details.passport_number_last4 is not null,
      'passport_issuing_country', v_details.passport_issuing_country,
      'passport_expires_on', v_details.passport_expires_on,
      'passport_name', v_details.passport_name) end
  );

  if cardinality(v_readable) > 0 and not private.work_details_view_logged_recently(v_share.id, v_share.person_id) then
    perform private.log_work_detail_event(v_share.person_id, 'work_details.viewed', v_share.org_id, v_share.engagement_id, v_readable, '{}', null);
    perform private.write_audit_event(v_share.org_id, 'work_details.viewed', 'app.work_detail_shares', v_share.id,
      jsonb_build_object('categories', to_jsonb(v_readable)));
  end if;
  return v_result;
end;
$$;

comment on function app.shared_work_details(uuid) is 'What the person an engagement names shared of their work details, for a member of the engaging org: only while the share stands and the engagement is Onboarding to Closing, and only the categories the reader''s project capabilities cover (private.work_detail_category_capabilities); other categories come back NULL. The passport number is always masked (last four only). Each read is logged in the person''s access log and the org''s audit ledger, once per reader and engagement every ten minutes.';

create or replace function app.reveal_shared_passport_number(p_engagement_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_share app.work_detail_shares;
  v_cipher bytea;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.can_read_work_detail_category(v_engagement.project_id, 'Passport') then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.read is required on the engagement''s project';
  end if;
  if not private.has_capability(v_engagement.org_id, 'data.restricted.read.government_id') then
    raise exception using errcode = '42501', message = 'data.restricted.read.government_id is required';
  end if;
  select * into v_share from app.work_detail_shares s
  where s.engagement_id = v_engagement.id and s.revoked_at is null and s.deleted_at is null;
  if v_share.id is null or not ('Passport' = any (v_share.categories))
     or not private.engagement_shares_work_details(v_engagement.engagement_state) then
    perform private.refuse('work_detail_not_shared', 'The person has not shared their passport details with this engagement.');
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Verify with your second factor before revealing a passport number.');
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    perform private.refuse('passport_reveal_reason', 'Write why you need the passport number, in at least 10 characters.');
  end if;
  select w.passport_number into v_cipher from app.person_work_details w where w.person_id = v_share.person_id and w.deleted_at is null;
  if v_cipher is null then
    perform private.refuse('passport_number_missing', 'No passport number is recorded.');
  end if;
  perform private.log_work_detail_event(v_share.person_id, 'passport.revealed', v_share.org_id, v_share.engagement_id,
    array['Passport']::app.work_detail_category[], '{}', left(btrim(p_reason), 500));
  perform private.write_audit_event(v_share.org_id, 'work_details.passport_revealed', 'app.work_detail_shares', v_share.id,
    jsonb_build_object('reason', left(btrim(p_reason), 500)));
  return extensions.pgp_sym_decrypt(v_cipher, private.passport_number_key());
end;
$$;

comment on function app.reveal_shared_passport_number(uuid, text) is 'The explicit reveal of a shared passport number to a member of the engaging org: needs a live share naming Passport on an open engagement, hospitality.fulfillment.read on the project, data.restricted.read.government_id in the org, step-up authentication (aal2) and a written reason. Logged with the reason, never the value, in the person''s access log and the org''s audit ledger.';

-- Account deletion -------------------------------------------------------------------------------------------------------------------------------

create or replace function private.erase_work_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share app.work_detail_shares;
begin
  for v_share in select * from app.work_detail_shares s where s.person_id = new.id and s.revoked_at is null and s.deleted_at is null loop
    perform private.close_work_detail_share(v_share, 'work_details.share_revoked');
  end loop;
  perform private.begin_trusted_operation('work_details_erase');
  delete from app.person_emergency_contacts where person_id = new.id;
  delete from app.person_loyalty_programs where person_id = new.id;
  delete from app.person_work_details where person_id = new.id;
  perform private.end_trusted_operation('work_details_erase');
  perform private.log_work_detail_event(new.id, 'work_details.erased', null, null, '{}', '{}', null);
  return null;
end;
$$;

comment on function private.erase_work_details() is 'After a person is deleted (account deletion, 1112): revokes their live work detail shares, withdraws the consents, and deletes their work details, emergency contacts and loyalty programs. The access log stays; it holds no values.';
revoke all on function private.erase_work_details() from public, anon, authenticated;

create trigger t60_erase_work_details after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.erase_work_details();

-- Privileges ----------------------------------------------------------------------------------------------------------------------------------------

revoke all on function app.ensure_my_work_details() from public, anon;
revoke all on function app.set_my_passport_number(text) from public, anon;
revoke all on function app.reveal_my_passport_number() from public, anon;
revoke all on function app.share_work_details(uuid, app.work_detail_category[], text) from public, anon;
revoke all on function app.revoke_work_detail_share(uuid) from public, anon;
revoke all on function app.my_work_detail_sharing() from public, anon;
revoke all on function app.shared_work_details(uuid) from public, anon;
revoke all on function app.reveal_shared_passport_number(uuid, text) from public, anon;
grant execute on function app.ensure_my_work_details() to authenticated, service_role;
grant execute on function app.set_my_passport_number(text) to authenticated, service_role;
grant execute on function app.reveal_my_passport_number() to authenticated, service_role;
grant execute on function app.share_work_details(uuid, app.work_detail_category[], text) to authenticated, service_role;
grant execute on function app.revoke_work_detail_share(uuid) to authenticated, service_role;
grant execute on function app.my_work_detail_sharing() to authenticated, service_role;
grant execute on function app.shared_work_details(uuid) to authenticated, service_role;
grant execute on function app.reveal_shared_passport_number(uuid, text) to authenticated, service_role;
