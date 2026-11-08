-- 6160_sensitive_data_consent.sql
-- RRR-248 issue 5, ADR 0164. Allergies, dietary needs, accessibility needs and supplier diversity status could be typed in
-- with no consent wording. This adds the recorded, specific, withdrawable consent that every entry point now passes.
--
--   * app.sensitive_data_consents: one row per grant. It holds the category, the basis (the person's own consent, or
--     someone else's attestation that they have the person's authority and that the person has had notice), the version
--     of the text shown, the language, the surface, who gave it, when, the IP address and its withdrawal. It is evidence:
--     nothing changes after capture but a one-time withdrawal. A withdrawal closes the row; a new grant opens a new row.
--   * private.sensitive_notice_versions: the text versions, with the SHA-256 of the en-US and es-US wording in
--     packages/i18n (a test in @xos/data fails when the wording changes without a new version here).
--   * private.sensitive_fields and app.sensitive_field_records: which columns each category covers and, per subject and
--     field, the consent the value was entered under, who entered it and when, and when it was cleared. Never a value, so
--     a report shows consent state without showing the data.
--   * The guard on the tables refuses a new value with no standing consent (sensitive_consent_required), so Atlas, Gateway,
--     Compass, API v1 and direct PostgREST writes are all covered by one rule. Clearing a value is always allowed. Nothing
--     here makes a field required. A migration or seed (no signed-in person, connected as postgres) writes without it.
--   * app.withdraw_sensitive_consent stops use at once and clears the values through private.erase_sensitive_category,
--     one call, as easy as giving consent. A legal hold over the person keeps the values, masked, until the hold ends; the
--     daily job of 6853 clears them then. Supplier diversity certifications are de-identified and soft deleted, so the
--     owner's access log still has something to point at.
--   * Account deletion (1112) withdraws everything the person gave or was the subject of, and closes what a guest list holds
--     about them (6852).
-- Functions start from their latest definitions: 4664_work_details_profile_move.sql for private.guard_person_work_details,
-- 2011_supplier_certificate_number_encryption.sql for private.guard_supplier_diversity_certification.

-- Enums ---------------------------------------------------------------------------------------------------------------

create type app.sensitive_data_category as enum ('Dietary and Allergies', 'Accessibility', 'Supplier Diversity');
comment on type app.sensitive_data_category is 'Categories of sensitive data consented to one by one. Dietary and Allergies can reveal health or religion, Accessibility can reveal disability, and Supplier Diversity can reveal race, sex, sexual orientation, disability or veteran status (ADR 0164).';

create type app.sensitive_consent_basis as enum ('Own Consent', 'Attested Authority');
comment on type app.sensitive_consent_basis is 'Why the data may be held: Own Consent is the person consenting for themselves; Attested Authority is someone else confirming that they have the person''s authority and that the person has had notice.';

create type app.sensitive_consent_surface as enum ('Atlas', 'Gateway', 'Compass', 'API');
comment on type app.sensitive_consent_surface is 'Where a sensitive data consent or attestation was captured.';

-- Text versions -------------------------------------------------------------------------------------------------------

create table private.sensitive_notice_versions (
  category app.sensitive_data_category not null,
  notice_version text not null,
  text_sha256_en_us text not null,
  text_sha256_es_us text not null,
  effective_at timestamptz not null default now(),
  retired_at timestamptz,
  primary key (category, notice_version),
  constraint sensitive_notice_versions_format check (notice_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$'),
  constraint sensitive_notice_versions_sha_en check (text_sha256_en_us ~ '^[0-9a-f]{64}$'),
  constraint sensitive_notice_versions_sha_es check (text_sha256_es_us ~ '^[0-9a-f]{64}$')
);

call private.describe('private.sensitive_notice_versions', 'Each version of the consent wording for a sensitive data category, with a hash of the exact en-US and es-US text in packages/i18n, so the record of a consent proves what the person was shown. A retired version is refused on new grants.', array[
  'category', 'Category the wording covers.',
  'notice_version', 'Version, as the date it took effect, with .n for a second one that day.',
  'text_sha256_en_us', 'SHA-256 of the canonical en-US wording.',
  'text_sha256_es_us', 'SHA-256 of the canonical es-US wording.',
  'effective_at', 'When this version took effect.',
  'retired_at', 'When new grants stopped accepting it; NULL while current.'
]);

alter table private.sensitive_notice_versions enable row level security;
revoke all on private.sensitive_notice_versions from public, anon, authenticated;
grant select on private.sensitive_notice_versions to service_role;

insert into private.sensitive_notice_versions (category, notice_version, text_sha256_en_us, text_sha256_es_us) values
  ('Dietary and Allergies', '2026-11-06', '303b3e622e4dfefa2eaf53a7868ae56d93aa00edf853cf86839dd8eb20b1ca8f', '39b497beacee16ea7be8c60264b5a185eb5db90b067a013a218d5d6ac7e4842a'),
  ('Accessibility', '2026-11-06', 'ee8488ba6d1f259158985e3c91fe765e15ed2c3159fc403eed8c1ee54e54c00a', 'f011dd994016f05b978c5d6dc8702ce54375597fe2e4ea9125d967a29cd684e7'),
  ('Supplier Diversity', '2026-11-06', '75bfaaa6f72191488dd503ce1b83ffb0464439164cb02cfb21cbee37224ea21d', '65a68564806dca003dbf0b6247ea5b3d9ee25e21e01259c4548323816c123fc5');

-- Consents ------------------------------------------------------------------------------------------------------------

create table app.sensitive_data_consents (
  id uuid primary key default private.uuid_v7(),
  category app.sensitive_data_category not null,
  basis app.sensitive_consent_basis not null,
  person_id uuid references app.people (id),
  account_id uuid references app.organizations (id),
  guest_list_entry_id uuid references app.guest_list_entries (id) on delete set null,
  org_id uuid references app.organizations (id),
  notice_version text not null,
  locale text not null,
  surface app.sensitive_consent_surface not null,
  authority_confirmed boolean not null default false,
  notice_confirmed boolean not null default false,
  values_saved boolean not null default true,
  given_by uuid not null references app.people (id),
  given_at timestamptz not null default now(),
  captured_ip inet,
  withdrawn_at timestamptz,
  withdrawn_by uuid references app.people (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sensitive_data_consents_locale check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  constraint sensitive_data_consents_withdrawn_after check (withdrawn_at is null or withdrawn_at >= given_at),
  constraint sensitive_data_consents_attested check (basis <> 'Attested Authority' or (authority_confirmed and notice_confirmed)),
  constraint sensitive_data_consents_own check (basis <> 'Own Consent' or person_id = given_by),
  constraint sensitive_data_consents_one_owner check (num_nonnulls(person_id, account_id) <= 1),
  constraint sensitive_data_consents_notice foreign key (category, notice_version)
    references private.sensitive_notice_versions (category, notice_version)
);

-- Withdrawing stays possible while an org is canceled and read-only (GDPR Article 7(3)).
insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.sensitive_data_consents', 'A person withdraws consent at any time, also while the org is read-only; a new attestation is refused by its RPC.');

create index sensitive_data_consents_person_id_idx on app.sensitive_data_consents (person_id);
create index sensitive_data_consents_account_id_idx on app.sensitive_data_consents (account_id);
create index sensitive_data_consents_guest_list_entry_id_idx on app.sensitive_data_consents (guest_list_entry_id);
create index sensitive_data_consents_org_id_idx on app.sensitive_data_consents (org_id);
create index sensitive_data_consents_given_by_idx on app.sensitive_data_consents (given_by);
create index sensitive_data_consents_withdrawn_by_idx on app.sensitive_data_consents (withdrawn_by);
create index sensitive_data_consents_notice_idx on app.sensitive_data_consents (category, notice_version);

-- At most one standing grant per subject: a person's own, a company's, a guest's, and one attestation per org for a person.
create unique index sensitive_data_consents_own_standing on app.sensitive_data_consents (person_id, category)
  where withdrawn_at is null and basis = 'Own Consent';
create unique index sensitive_data_consents_account_standing on app.sensitive_data_consents (account_id, category)
  where withdrawn_at is null and account_id is not null;
create unique index sensitive_data_consents_guest_standing on app.sensitive_data_consents (guest_list_entry_id, category)
  where withdrawn_at is null and guest_list_entry_id is not null;
create unique index sensitive_data_consents_attested_standing on app.sensitive_data_consents (person_id, category, org_id)
  where withdrawn_at is null and basis = 'Attested Authority' and guest_list_entry_id is null;

call private.describe('app.sensitive_data_consents', 'Consent to hold one category of sensitive data, or an attestation by someone else that they have the person''s authority and that the person has had notice. Evidence: written only by the database, and nothing changes after capture but a one-time withdrawal. The subject sees every row about them; a withdrawal stops use and clears the values.', array[
  'id', 'Primary key, UUID v7.',
  'category', 'Category consented to.',
  'basis', 'Own Consent, or Attested Authority when someone else entered it.',
  'person_id', 'Person the data is about; NULL for a company, for a guest with no account, or once the person an email matched said the guest is someone else.',
  'account_id', 'External account (company) whose supplier diversity status it covers; NULL otherwise.',
  'guest_list_entry_id', 'Guest list entry the attestation covers; NULL otherwise.',
  'org_id', 'Org whose member attested; NULL for a person''s own consent.',
  'notice_version', 'Version of the wording shown (private.sensitive_notice_versions).',
  'locale', 'Language the wording was shown in, for example en-US.',
  'surface', 'Where it was captured.',
  'authority_confirmed', 'The person attesting confirmed they have the person''s authority to enter this.',
  'notice_confirmed', 'The person attesting confirmed the person has had notice of what is entered and why.',
  'values_saved', 'False for an attestation about someone who withdrew or removed it: it records that someone attested, and nothing was saved under it. Nothing reads values on it.',
  'given_by', 'Person who consented or attested.',
  'given_at', 'When it was given. Set by the database.',
  'captured_ip', 'Client IP address at capture, as evidence: passed by the platform server, or read from the request when absent. Only the database writes it.',
  'withdrawn_at', 'When it was withdrawn; NULL while it stands.',
  'withdrawn_by', 'Person who withdrew it; NULL for the database, or while it stands.',
  'created_at', 'When the row was created.',
  'updated_at', 'When the row last changed: its withdrawal.'
]);

alter table app.sensitive_data_consents enable row level security;
revoke all on app.sensitive_data_consents from public, anon, authenticated;
-- Whoever gave an attestation, and the org's data.request.manage holders, read its row too. person_id would tell them that an
-- address has an account, values_saved and withdrawn_by that its owner withdrew, and captured_ip belongs to whoever attested
-- and is not for the person it is about. So none of those four is selectable: the person reads what is about them through
-- app.sensitive_entries_about_me and app.my_sensitive_consents.
grant select (id, category, basis, account_id, guest_list_entry_id, org_id, notice_version, locale, surface,
  authority_confirmed, notice_confirmed, given_by, given_at, withdrawn_at, created_at, updated_at)
  on app.sensitive_data_consents to authenticated;
grant all on app.sensitive_data_consents to service_role;
create policy sensitive_data_consents_read on app.sensitive_data_consents for select to authenticated
  using (person_id = (select private.current_person_id())
    or given_by = (select private.current_person_id())
    or (account_id is not null and account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])))
    or (org_id is not null and org_id in (select private.orgs_with_capability('data.request.manage'))));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.sensitive_data_consents', 'Age', 'withdrawn_at', interval '7 years', 'Delete', 'Evidence of consent and its withdrawal, kept 7 years after withdrawal; it holds no values.');

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.sensitive_data_consents', 'Consent to hold sensitive data can itself reveal a health or protected status (ADR 0164).');

create or replace function private.guard_sensitive_data_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.given_at := now();
    -- The web apps call through their server, so the request's own address is theirs: they pass the client's (0850).
    new.captured_ip := coalesce(new.captured_ip, private.request_ip());
    new.withdrawn_at := null;
    new.withdrawn_by := null;
    return new;
  end if;
  if (to_jsonb(new) - array['withdrawn_at', 'withdrawn_by', 'guest_list_entry_id', 'person_id', 'updated_at']) <> (to_jsonb(old) - array['withdrawn_at', 'withdrawn_by', 'guest_list_entry_id', 'person_id', 'updated_at'])
     or (new.person_id is distinct from old.person_id
         and not (old.person_id is null and old.guest_list_entry_id is not null and private.in_trusted_operation('sensitive_guest_link'))
         and not (new.person_id is null and old.guest_list_entry_id is not null and private.in_trusted_operation('sensitive_guest_disown'))) then
    perform private.refuse('consent_immutable', 'A consent record is evidence; only its withdrawal is recorded.');
  end if;
  if old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at then
    perform private.refuse('consent_already_withdrawn', 'Withdrawn consent stays withdrawn; record a new grant instead.');
  end if;
  if new.withdrawn_at is not null and old.withdrawn_at is null then
    new.withdrawn_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.guard_sensitive_data_consent() is 'Sensitive data consents: the capture time comes from the database and the IP address from the platform server or the request; nothing changes afterwards but a one-time withdrawal stamped with the database time, naming the person on a guest''s attestation once a verified sign-in matches its email (private.link_guest_needs_to_person), and taking that name off at the person''s word that the guest is someone else (app.disown_sensitive_entry).';
revoke all on function private.guard_sensitive_data_consent() from public, anon, authenticated;

create trigger t40_guard_sensitive_data_consent before insert or update on app.sensitive_data_consents
  for each row execute function private.guard_sensitive_data_consent();

-- Fields and the field-level record -----------------------------------------------------------------------------------

create table private.sensitive_fields (
  code text primary key,
  category app.sensitive_data_category not null,
  table_name text not null,
  column_name text not null,
  sort_order smallint not null,
  constraint sensitive_fields_code check (code ~ '^[a-z][a-z_]*$'),
  constraint sensitive_fields_table_column unique (table_name, column_name)
);

call private.describe('private.sensitive_fields', 'The columns each sensitive data category covers. A report lists these fields with their consent state, never their values.', array[
  'code', 'Field code the report and its labels use.',
  'category', 'Category that covers the field.',
  'table_name', 'Table of the column.',
  'column_name', 'Column.',
  'sort_order', 'Display order.'
]);

alter table private.sensitive_fields enable row level security;
revoke all on private.sensitive_fields from public, anon, authenticated;
grant select on private.sensitive_fields to service_role;

insert into private.sensitive_fields (code, category, table_name, column_name, sort_order) values
  ('dietary_needs', 'Dietary and Allergies', 'app.person_work_details', 'dietary_needs', 10),
  ('allergies', 'Dietary and Allergies', 'app.person_work_details', 'allergies', 20),
  ('dietary_notes', 'Dietary and Allergies', 'app.person_work_details', 'dietary_notes', 30),
  ('accessibility_needs', 'Accessibility', 'app.person_work_details', 'accessibility_needs', 50),
  ('accessibility_notes', 'Accessibility', 'app.person_work_details', 'accessibility_notes', 60),
  ('supplier_diversity_kind', 'Supplier Diversity', 'app.supplier_diversity_certifications', 'diversity_kind', 70),
  ('supplier_diversity_certificate', 'Supplier Diversity', 'app.supplier_diversity_certifications', 'certificate_number', 80);

create table app.sensitive_field_records (
  id uuid primary key default private.uuid_v7(),
  field_code text not null references private.sensitive_fields (code),
  person_id uuid references app.people (id),
  account_id uuid references app.organizations (id),
  guest_list_entry_id uuid references app.guest_list_entries (id) on delete set null,
  consent_id uuid references app.sensitive_data_consents (id),
  entered_by uuid references app.people (id),
  entered_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  cleared_at timestamptz,
  awaiting_since timestamptz,
  awaiting_notified_at timestamptz,
  constraint sensitive_field_records_one_owner check (num_nonnulls(person_id, account_id) <= 1)
);

create index sensitive_field_records_field_code_idx on app.sensitive_field_records (field_code);
create index sensitive_field_records_consent_id_idx on app.sensitive_field_records (consent_id);
create index sensitive_field_records_entered_by_idx on app.sensitive_field_records (entered_by);
create index sensitive_field_records_guest_list_entry_id_idx on app.sensitive_field_records (guest_list_entry_id);
create unique index sensitive_field_records_person_key on app.sensitive_field_records (person_id, field_code)
  where person_id is not null and guest_list_entry_id is null;
create unique index sensitive_field_records_account_key on app.sensitive_field_records (account_id, field_code) where account_id is not null;
create unique index sensitive_field_records_guest_key on app.sensitive_field_records (guest_list_entry_id, field_code)
  where guest_list_entry_id is not null;
create index sensitive_field_records_awaiting_idx on app.sensitive_field_records (awaiting_since) where awaiting_since is not null and cleared_at is null;

call private.describe('app.sensitive_field_records', 'Per subject and sensitive field: the consent the value was entered under, who entered it and when, and when it was cleared. Never a value. Written only by the database; the subject reads their own.', array[
  'id', 'Primary key, UUID v7.',
  'field_code', 'Field (private.sensitive_fields).',
  'person_id', 'Person the field is about; NULL for a company, or for a guest with no account.',
  'account_id', 'External account the field is about; NULL otherwise.',
  'guest_list_entry_id', 'Guest list entry the field is about; NULL otherwise.',
  'consent_id', 'Consent the value stands on; NULL for a value from before consent was recorded, until the person confirms or it is cleared.',
  'entered_by', 'Person who last entered the value; NULL for a value from before this record.',
  'entered_at', 'When a value was first entered, or when this record began for an older value.',
  'changed_at', 'When the value last changed.',
  'cleared_at', 'When the value was cleared; NULL while one is held.',
  'awaiting_since', 'When a value from before consent was recorded started waiting for it; the daily job clears it 30 days after telling the person (6853).',
  'awaiting_notified_at', 'When the daily job told the person a value is waiting for their consent; NULL until then.'
]);

alter table app.sensitive_field_records enable row level security;
revoke all on app.sensitive_field_records from public, anon, authenticated;
grant select on app.sensitive_field_records to authenticated;
grant all on app.sensitive_field_records to service_role;
create policy sensitive_field_records_read on app.sensitive_field_records for select to authenticated
  using (person_id = (select private.current_person_id())
    or (account_id is not null and account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.sensitive_field_records', 'Age', 'cleared_at', interval '7 years', 'Delete', 'Evidence that a value stood on consent and was cleared, kept 7 years after clearing; it holds no values.');

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.sensitive_field_records', 'Which sensitive fields a person holds can itself reveal a health or protected status (ADR 0164).');

-- The standing consent ------------------------------------------------------------------------------------------------

create or replace function private.sensitive_consent_id(p_person_id uuid, p_category app.sensitive_data_category)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.sensitive_data_consents c
  where c.person_id = p_person_id and c.category = p_category and c.basis = 'Own Consent' and c.withdrawn_at is null;
$$;

comment on function private.sensitive_consent_id(uuid, app.sensitive_data_category) is 'The person''s own standing consent for a category, or NULL.';
revoke all on function private.sensitive_consent_id(uuid, app.sensitive_data_category) from public, anon, authenticated;

create or replace function private.sensitive_consent_stands(p_person_id uuid, p_category app.sensitive_data_category)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.sensitive_consent_id(p_person_id, p_category) is not null;
$$;

comment on function private.sensitive_consent_stands(uuid, app.sensitive_data_category) is 'True while the person''s own consent for the category stands. Every read of their values by someone else checks it.';
revoke all on function private.sensitive_consent_stands(uuid, app.sensitive_data_category) from public, anon, authenticated;

create or replace function private.sensitive_account_consent_id(p_account_id uuid, p_category app.sensitive_data_category)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.sensitive_data_consents c
  where c.account_id = p_account_id and c.category = p_category and c.withdrawn_at is null;
$$;

comment on function private.sensitive_account_consent_id(uuid, app.sensitive_data_category) is 'The standing attestation of a company for a category, or NULL.';
revoke all on function private.sensitive_account_consent_id(uuid, app.sensitive_data_category) from public, anon, authenticated;

create or replace function private.sensitive_write_is_system()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_person_id() is null and session_user = 'postgres';
$$;

comment on function private.sensitive_write_is_system() is 'True for a migration, a seed or a scheduled job: connected as postgres with no signed-in person. A service role request comes through the API as authenticator and is not one.';
revoke all on function private.sensitive_write_is_system() from public, anon, authenticated;

create or replace function private.refuse_without_sensitive_consent(p_category app.sensitive_data_category)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.refuse('sensitive_consent_required', format(
    'Give your consent to %s data before saving it. Nothing else on the form needs it.', p_category));
end;
$$;

comment on function private.refuse_without_sensitive_consent(app.sensitive_data_category) is 'The one refusal of a sensitive value with no standing consent: sensitive_consent_required, naming the category.';
revoke all on function private.refuse_without_sensitive_consent(app.sensitive_data_category) from public, anon, authenticated;

-- Field-level record --------------------------------------------------------------------------------------------------

create or replace function private.record_sensitive_field(
  p_field_code text,
  p_present boolean,
  p_consent_id uuid,
  p_person_id uuid default null,
  p_account_id uuid default null,
  p_guest_list_entry_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select r.id into v_id from app.sensitive_field_records r
  where r.field_code = p_field_code
    and case
      when p_guest_list_entry_id is not null then r.guest_list_entry_id = p_guest_list_entry_id
      when p_account_id is not null then r.account_id = p_account_id
      else r.person_id = p_person_id and r.guest_list_entry_id is null end
  for update;
  if p_present then
    if v_id is null then
      insert into app.sensitive_field_records (field_code, person_id, account_id, guest_list_entry_id, consent_id, entered_by, awaiting_since)
      values (p_field_code, p_person_id, p_account_id, p_guest_list_entry_id, p_consent_id, private.current_person_id(),
        case when p_consent_id is null then now() end);
    else
      -- Only a grant ends a wait. A value still held with no grant keeps its record, its clock and its notice as they stand.
      update app.sensitive_field_records r set
        consent_id = case when p_consent_id is not null then p_consent_id when r.cleared_at is not null then null else r.consent_id end,
        entered_by = case when p_consent_id is not null or r.cleared_at is not null then private.current_person_id() else r.entered_by end,
        entered_at = case when r.cleared_at is null then r.entered_at else now() end,
        changed_at = now(),
        cleared_at = null,
        awaiting_since = case
          when p_consent_id is not null then null
          when r.cleared_at is not null then now()
          when r.consent_id is null then coalesce(r.awaiting_since, now())
          else r.awaiting_since end,
        awaiting_notified_at = case when p_consent_id is not null or r.cleared_at is not null then null else r.awaiting_notified_at end,
        person_id = case when p_guest_list_entry_id is not null then p_person_id else r.person_id end
      where r.id = v_id;
    end if;
  elsif v_id is not null then
    update app.sensitive_field_records r set cleared_at = now(), changed_at = now(), awaiting_since = null, awaiting_notified_at = null
    where r.id = v_id and r.cleared_at is null;
  end if;
end;
$$;

comment on function private.record_sensitive_field(text, boolean, uuid, uuid, uuid, uuid) is 'Keeps the field-level record of one field of one subject: the consent and who entered a value, or when it was cleared. Never a value. A value held with no grant stays waiting: only a grant, or clearing it, ends the wait, so saving the rest of a form leaves the 30-day clock running.';
revoke all on function private.record_sensitive_field(text, boolean, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- The guard on person work details ------------------------------------------------------------------------------------

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
  -- R6a: uniform sizes and travel preferences are entered per roster entry now; the profile columns stay NULL.
  if not private.in_trusted_operation('work_details_profile_move') and (
       (tg_op = 'INSERT' and num_nonnulls(new.shirt_size, new.jacket_size, new.pants_size, new.shoe_size, new.glove_size,
          new.hat_size, new.uniform_notes, new.seat_preference, new.meal_preference, new.home_airport) > 0)
       or (tg_op = 'UPDATE' and (
          (new.shirt_size is not null and new.shirt_size is distinct from old.shirt_size)
          or (new.jacket_size is not null and new.jacket_size is distinct from old.jacket_size)
          or (new.pants_size is not null and new.pants_size is distinct from old.pants_size)
          or (new.shoe_size is not null and new.shoe_size is distinct from old.shoe_size)
          or (new.glove_size is not null and new.glove_size is distinct from old.glove_size)
          or (new.hat_size is not null and new.hat_size is distinct from old.hat_size)
          or (new.uniform_notes is not null and new.uniform_notes is distinct from old.uniform_notes)
          or (new.seat_preference is not null and new.seat_preference is distinct from old.seat_preference)
          or (new.meal_preference is not null and new.meal_preference is distinct from old.meal_preference)
          or (new.home_airport is not null and new.home_airport is distinct from old.home_airport)))) then
    perform private.refuse('work_detail_field_moved',
      'Uniform sizes and travel preferences are no longer kept on your profile; enter them on each project you are rostered on.');
  end if;
  -- Each need once, in enum order, so a diff shows a real change.
  new.dietary_needs := coalesce((select array_agg(distinct d order by d) from unnest(new.dietary_needs) d), '{}');
  new.accessibility_needs := coalesce((select array_agg(distinct a order by a) from unnest(new.accessibility_needs) a), '{}');
  -- ADR 0164: a new value needs the person's standing consent. Clearing one never does.
  if not private.sensitive_write_is_system() then
    if ((cardinality(new.dietary_needs) > 0 and (tg_op = 'INSERT' or new.dietary_needs is distinct from old.dietary_needs))
        or (new.allergies is not null and (tg_op = 'INSERT' or new.allergies is distinct from old.allergies))
        or (new.dietary_notes is not null and (tg_op = 'INSERT' or new.dietary_notes is distinct from old.dietary_notes)))
       and not private.sensitive_consent_stands(new.person_id, 'Dietary and Allergies') then
      perform private.refuse_without_sensitive_consent('Dietary and Allergies');
    end if;
    if ((cardinality(new.accessibility_needs) > 0 and (tg_op = 'INSERT' or new.accessibility_needs is distinct from old.accessibility_needs))
        or (new.accessibility_notes is not null and (tg_op = 'INSERT' or new.accessibility_notes is distinct from old.accessibility_notes)))
       and not private.sensitive_consent_stands(new.person_id, 'Accessibility') then
      perform private.refuse_without_sensitive_consent('Accessibility');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_person_work_details() is 'Person work details: the passport number and its last four change only inside the encrypting RPC; the retired uniform size and travel preference columns take no value (work_detail_field_moved, R6a) outside the one-time move; dietary and accessibility needs are kept once each, in enum order; a new dietary, allergy or accessibility value needs the person''s standing consent (sensitive_consent_required, ADR 0164), and clearing one never does.';
revoke all on function private.guard_person_work_details() from public, anon, authenticated;

create or replace function private.record_work_detail_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := coalesce(new.person_id, old.person_id);
  v_diet uuid := private.sensitive_consent_id(v_person, 'Dietary and Allergies');
  v_access uuid := private.sensitive_consent_id(v_person, 'Accessibility');
  v_live boolean := tg_op <> 'DELETE' and new.deleted_at is null;
begin
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null) then
    perform private.record_sensitive_field('dietary_needs', false, null, v_person);
    perform private.record_sensitive_field('allergies', false, null, v_person);
    perform private.record_sensitive_field('dietary_notes', false, null, v_person);
    perform private.record_sensitive_field('accessibility_needs', false, null, v_person);
    perform private.record_sensitive_field('accessibility_notes', false, null, v_person);
    return null;
  end if;
  if tg_op = 'INSERT' or new.dietary_needs is distinct from old.dietary_needs then
    perform private.record_sensitive_field('dietary_needs', v_live and cardinality(new.dietary_needs) > 0, v_diet, v_person);
  end if;
  if tg_op = 'INSERT' or new.allergies is distinct from old.allergies then
    perform private.record_sensitive_field('allergies', v_live and new.allergies is not null, v_diet, v_person);
  end if;
  if tg_op = 'INSERT' or new.dietary_notes is distinct from old.dietary_notes then
    perform private.record_sensitive_field('dietary_notes', v_live and new.dietary_notes is not null, v_diet, v_person);
  end if;
  if tg_op = 'INSERT' or new.accessibility_needs is distinct from old.accessibility_needs then
    perform private.record_sensitive_field('accessibility_needs', v_live and cardinality(new.accessibility_needs) > 0, v_access, v_person);
  end if;
  if tg_op = 'INSERT' or new.accessibility_notes is distinct from old.accessibility_notes then
    perform private.record_sensitive_field('accessibility_notes', v_live and new.accessibility_notes is not null, v_access, v_person);
  end if;
  return null;
end;
$$;

comment on function private.record_work_detail_sensitive_fields() is 'After a person''s work details change: keeps the field-level record of their dietary, allergy and accessibility fields, never the values.';
revoke all on function private.record_work_detail_sensitive_fields() from public, anon, authenticated;

create trigger t86_record_sensitive_fields after insert or update or delete on app.person_work_details
  for each row execute function private.record_work_detail_sensitive_fields();

-- The guard on supplier diversity certifications ----------------------------------------------------------------------

create or replace function private.guard_supplier_diversity_certification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.person_id is distinct from old.person_id or new.account_id is distinct from old.account_id) then
    perform private.refuse('owner_immutable', 'A supplier diversity certification never moves to another owner.');
  end if;
  if new.account_id is not null and not exists (
      select 1 from app.account_memberships m where m.org_id = new.account_id and m.deleted_at is null) then
    perform private.refuse('supplier_diversity_account', 'A company declares supplier diversity certifications on its external account.');
  end if;
  if (tg_op = 'INSERT' and (new.certificate_number is not null or new.certificate_number_last4 is not null))
     or (tg_op = 'UPDATE' and (new.certificate_number is distinct from old.certificate_number
                               or new.certificate_number_last4 is distinct from old.certificate_number_last4)) then
    if not private.in_trusted_operation('supplier_certificate_number_write') then
      perform private.refuse('certificate_number_rpc_only', 'A certificate number is written only through app.set_supplier_diversity_certificate_number, which encrypts it.');
    end if;
  end if;
  new.certifying_body := btrim(new.certifying_body);
  -- ADR 0164: a new or changed declaration needs the owner's standing consent, or for a company the attestation of the
  -- Owner or Admin who declares it. Removing one never does.
  if not private.sensitive_write_is_system() and not private.in_trusted_operation('sensitive_data_erase')
     and new.deleted_at is null and (tg_op = 'INSERT'
       or new.diversity_kind is distinct from old.diversity_kind
       or new.certifying_body is distinct from old.certifying_body
       or new.certificate_number is distinct from old.certificate_number
       or new.issued_on is distinct from old.issued_on
       or new.expires_on is distinct from old.expires_on
       or new.evidence_path is distinct from old.evidence_path) then
    if (new.account_id is not null and private.sensitive_account_consent_id(new.account_id, 'Supplier Diversity') is null)
       or (new.person_id is not null and not private.sensitive_consent_stands(new.person_id, 'Supplier Diversity')) then
      perform private.refuse_without_sensitive_consent('Supplier Diversity');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_supplier_diversity_certification() is 'Supplier diversity certifications keep their owner, belong to a person or an external account, store trimmed text, take a certificate number only inside the encrypting RPC, and need the owner''s standing consent, or a company''s standing attestation, for a new or changed declaration (sensitive_consent_required, ADR 0164). Removing one never does.';
revoke all on function private.guard_supplier_diversity_certification() from public, anon, authenticated;

create or replace function private.record_supplier_diversity_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := coalesce(new.person_id, old.person_id);
  v_account uuid := coalesce(new.account_id, old.account_id);
  v_consent uuid := case when v_account is not null then private.sensitive_account_consent_id(v_account, 'Supplier Diversity')
                         else private.sensitive_consent_id(v_person, 'Supplier Diversity') end;
  v_any boolean;
  v_number boolean;
begin
  select coalesce(bool_or(true), false), coalesce(bool_or(c.certificate_number is not null), false) into v_any, v_number
  from app.supplier_diversity_certifications c
  where c.deleted_at is null
    and ((v_account is not null and c.account_id = v_account) or (v_account is null and c.person_id = v_person));
  perform private.record_sensitive_field('supplier_diversity_kind', v_any, v_consent, v_person, v_account);
  perform private.record_sensitive_field('supplier_diversity_certificate', v_number, v_consent, v_person, v_account);
  return null;
end;
$$;

comment on function private.record_supplier_diversity_sensitive_fields() is 'After a supplier diversity certification changes: keeps the field-level record of its owner, without any value.';
revoke all on function private.record_supplier_diversity_sensitive_fields() from public, anon, authenticated;

create trigger t86_record_sensitive_fields after insert or update or delete on app.supplier_diversity_certifications
  for each row execute function private.record_supplier_diversity_sensitive_fields();

-- Stopping use and clearing the values --------------------------------------------------------------------------------

create or replace function private.person_on_legal_hold(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.legal_holds h
    where h.released_at is null and h.deleted_at is null
      and h.org_id in (select private.person_related_org_ids(p_person_id))
      and (h.table_name is null or h.table_name = any (private.account_deletion_tables())));
$$;

comment on function private.person_on_legal_hold(uuid) is 'True while an org the person belongs to or works for holds a legal hold that reaches their data, the rule that also refuses their account deletion (1112).';
revoke all on function private.person_on_legal_hold(uuid) from public, anon, authenticated;

create or replace function private.sensitive_subject_on_hold(p_person_id uuid, p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (p_person_id is not null and private.person_on_legal_hold(p_person_id))
    or (p_account_id is not null and p_account_id in (select private.held_org_ids('app.supplier_diversity_certifications')));
$$;

comment on function private.sensitive_subject_on_hold(uuid, uuid) is 'True while a legal hold reaches a person''s data, or a company''s supplier diversity certifications: their sensitive values stay, hidden, until it ends.';
revoke all on function private.sensitive_subject_on_hold(uuid, uuid) from public, anon, authenticated;

create or replace function private.remove_work_detail_share_category(p_person_id uuid, p_category app.work_detail_category)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.work_detail_shares;
  v_left app.work_detail_category[];
begin
  for v_share in
    select * from app.work_detail_shares s
    where s.person_id = p_person_id and s.revoked_at is null and s.deleted_at is null and p_category = any (s.categories)
    order by s.shared_at, s.id
    for update
  loop
    v_left := array_remove(v_share.categories, p_category);
    -- Contact is never shared alone (R6a), so a share left with only Contact closes too.
    if cardinality(array_remove(v_left, 'Contact')) = 0 then
      perform private.close_work_detail_share(v_share, 'work_details.share_revoked');
    else
      update app.work_detail_shares s set categories = v_left where s.id = v_share.id;
      perform private.log_work_detail_event(v_share.person_id, 'work_details.share_changed', v_share.org_id, v_share.engagement_id,
        v_left, '{}', null, v_share.roster_entry_id);
    end if;
  end loop;
end;
$$;

comment on function private.remove_work_detail_share_category(uuid, app.work_detail_category) is 'Takes one category off every live share of the person, closing a share left with nothing but Contact as a revocation.';
revoke all on function private.remove_work_detail_share_category(uuid, app.work_detail_category) from public, anon, authenticated;

create or replace function private.erase_supplier_diversity_values(p_person_id uuid, p_account_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share app.supplier_diversity_shares;
  v_cert app.supplier_diversity_certifications;
begin
  for v_cert in
    select c.* from app.supplier_diversity_certifications c
    where ((p_account_id is not null and c.account_id = p_account_id) or (p_account_id is null and c.person_id = p_person_id))
      and (c.deleted_at is null or c.diversity_kind <> 'Other' or c.certifying_body <> 'Removed')
    for update
  loop
    for v_share in
      select s.* from app.supplier_diversity_shares s
      where s.supplier_diversity_certification_id = v_cert.id and s.revoked_at is null and s.deleted_at is null
      for update
    loop
      update app.supplier_diversity_shares set revoked_at = now() where id = v_share.id;
      if not exists (select 1 from app.supplier_diversity_shares s
                     where s.consent_record_id = v_share.consent_record_id and s.revoked_at is null and s.deleted_at is null) then
        update app.consent_records set withdrawn_at = now() where id = v_share.consent_record_id and withdrawn_at is null;
      end if;
      perform private.log_supplier_diversity_event(v_cert.id, 'supplier_diversity.share_revoked', v_share.org_id);
      perform private.write_audit_event(v_share.org_id, 'supplier_diversity.share_revoked', 'app.supplier_diversity_shares', v_share.id, '{}'::jsonb);
    end loop;
    -- De-identified, not deleted: the access log keeps pointing at the row and says nothing about the person.
    perform private.begin_trusted_operation('supplier_certificate_number_write');
    perform private.begin_trusted_operation('sensitive_data_erase');
    update app.supplier_diversity_certifications c set
      diversity_kind = 'Other', certifying_body = 'Removed', certificate_number = null, certificate_number_last4 = null,
      issued_on = null, expires_on = null, evidence_path = null, deleted_at = coalesce(c.deleted_at, now())
    where c.id = v_cert.id;
    perform private.end_trusted_operation('sensitive_data_erase');
    perform private.end_trusted_operation('supplier_certificate_number_write');
  end loop;
end;
$$;

comment on function private.erase_supplier_diversity_values(uuid, uuid) is 'Revokes every live share of an owner''s supplier diversity certifications and de-identifies the rows: kind Other, body Removed, number, dates and evidence path cleared, soft deleted. An evidence file already uploaded stays in storage until the row purge runs (ADR 0164).';
revoke all on function private.erase_supplier_diversity_values(uuid, uuid) from public, anon, authenticated;

create or replace function private.erase_sensitive_category(p_person_id uuid, p_account_id uuid, p_category app.sensitive_data_category)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if private.sensitive_subject_on_hold(p_person_id, p_account_id) then
    return false;
  end if;
  if p_category = 'Supplier Diversity' then
    perform private.erase_supplier_diversity_values(p_person_id, p_account_id);
    return true;
  end if;
  if p_category = 'Dietary and Allergies' then
    update app.person_work_details w set dietary_needs = '{}', allergies = null, dietary_notes = null
    where w.person_id = p_person_id and (cardinality(w.dietary_needs) > 0 or w.allergies is not null or w.dietary_notes is not null);
    perform private.remove_work_detail_share_category(p_person_id, 'Dietary Needs');
  elsif p_category = 'Accessibility' then
    update app.person_work_details w set accessibility_needs = '{}', accessibility_notes = null
    where w.person_id = p_person_id and (cardinality(w.accessibility_needs) > 0 or w.accessibility_notes is not null);
    perform private.remove_work_detail_share_category(p_person_id, 'Accessibility Needs');
  end if;
  return true;
end;
$$;

comment on function private.erase_sensitive_category(uuid, uuid, app.sensitive_data_category) is 'Clears the values of one category for a person or company and takes the category off their shares. Returns false, clearing nothing, while a legal hold reaches the person: the values stay masked and the daily job clears them when the hold ends. 6852 widens it to guest and roster values.';
revoke all on function private.erase_sensitive_category(uuid, uuid, app.sensitive_data_category) from public, anon, authenticated;

-- Giving and withdrawing ----------------------------------------------------------------------------------------------

create or replace function private.assert_sensitive_notice(p_category app.sensitive_data_category, p_notice_version text, p_locale text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.sensitive_notice_versions v
                 where v.category = p_category and v.notice_version = p_notice_version and v.retired_at is null) then
    perform private.refuse('sensitive_notice_version', 'This wording is out of date. Reload to read the current version.');
  end if;
  if coalesce(p_locale, '') !~ '^[a-z]{2}-[A-Z]{2}$' then
    perform private.refuse('sensitive_notice_locale', 'Name the language the wording was shown in, for example en-US.');
  end if;
end;
$$;

comment on function private.assert_sensitive_notice(app.sensitive_data_category, text, text) is 'Refuses a grant under a retired or unknown version of the wording, or with no language.';
revoke all on function private.assert_sensitive_notice(app.sensitive_data_category, text, text) from public, anon, authenticated;

create or replace function app.give_sensitive_consent(
  p_category app.sensitive_data_category,
  p_notice_version text,
  p_locale text,
  p_surface app.sensitive_consent_surface,
  p_account_id uuid default null,
  p_authority_confirmed boolean default false,
  p_notice_confirmed boolean default false,
  p_client_ip inet default null
)
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
  perform private.assert_sensitive_notice(p_category, p_notice_version, p_locale);
  if p_account_id is not null then
    if p_category <> 'Supplier Diversity' then
      perform private.refuse('sensitive_consent_category', 'A company holds only supplier diversity status.');
    end if;
    if p_account_id not in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])) then
      perform private.refuse('supplier_diversity_not_yours', 'Only an Owner or Admin of the company declares its supplier diversity status.');
    end if;
    if not (coalesce(p_authority_confirmed, false) and coalesce(p_notice_confirmed, false)) then
      perform private.refuse('sensitive_attestation_required', 'Confirm you have authority to declare this and that the people it describes have had notice.');
    end if;
    v_id := private.sensitive_account_consent_id(p_account_id, p_category);
    if v_id is null then
      insert into app.sensitive_data_consents (category, basis, account_id, notice_version, locale, surface,
        authority_confirmed, notice_confirmed, given_by, captured_ip)
      values (p_category, 'Attested Authority', p_account_id, p_notice_version, p_locale, p_surface, true, true, v_me, p_client_ip)
      returning id into v_id;
      perform private.write_audit_event(p_account_id, 'sensitive_consent.given', 'app.sensitive_data_consents', v_id,
        jsonb_build_object('category', p_category, 'basis', 'Attested Authority', 'notice_version', p_notice_version));
    end if;
  else
    v_id := private.sensitive_consent_id(v_me, p_category);
    if v_id is null then
      insert into app.sensitive_data_consents (category, basis, person_id, notice_version, locale, surface, given_by, captured_ip)
      values (p_category, 'Own Consent', v_me, p_notice_version, p_locale, p_surface, v_me, p_client_ip)
      returning id into v_id;
      perform private.log_work_detail_event(v_me, 'sensitive_consent.given', null, null, '{}', '{}', null);
    end if;
  end if;
  -- A value from before consent was recorded now stands on this consent.
  update app.sensitive_field_records r set consent_id = v_id, awaiting_since = null, awaiting_notified_at = null
  from private.sensitive_fields f
  where f.code = r.field_code and f.category = p_category and r.cleared_at is null and r.guest_list_entry_id is null
    and ((p_account_id is not null and r.account_id = p_account_id) or (p_account_id is null and r.person_id = v_me))
    and (r.consent_id is null or r.consent_id <> v_id);
  return v_id;
end;
$$;

comment on function app.give_sensitive_consent(app.sensitive_data_category, text, text, app.sensitive_consent_surface, uuid, boolean, boolean, inet) is 'The signed-in person gives their own consent for one category, with the version and language of the wording they were shown and the surface; or, with an account, an Owner or Admin attests for the company''s supplier diversity status. Idempotent while a grant stands. Refuses sensitive_notice_version, sensitive_notice_locale, sensitive_attestation_required, sensitive_consent_category and supplier_diversity_not_yours. Returns the consent id. Values from before consent was recorded stand on it from then on. p_client_ip is the address the platform server saw, as in app.record_legal_acceptances; without it the request''s is recorded. It is evidence, not an access control.';
revoke all on function app.give_sensitive_consent(app.sensitive_data_category, text, text, app.sensitive_consent_surface, uuid, boolean, boolean, inet) from public, anon;
grant execute on function app.give_sensitive_consent(app.sensitive_data_category, text, text, app.sensitive_consent_surface, uuid, boolean, boolean, inet) to authenticated, service_role;

create or replace function private.close_sensitive_consent(p_consent app.sensitive_data_consents)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.sensitive_data_consents c set withdrawn_at = now(), withdrawn_by = private.current_person_id()
  where c.id = p_consent.id and c.withdrawn_at is null;
end;
$$;

comment on function private.close_sensitive_consent(app.sensitive_data_consents) is 'Stamps the withdrawal of one grant.';
revoke all on function private.close_sensitive_consent(app.sensitive_data_consents) from public, anon, authenticated;

create or replace function app.withdraw_sensitive_consent(
  p_category app.sensitive_data_category,
  p_account_id uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_consent app.sensitive_data_consents;
  v_erased boolean;
begin
  if p_account_id is not null then
    if p_account_id not in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])) then
      perform private.refuse('supplier_diversity_not_yours', 'Only an Owner or Admin of the company withdraws its supplier diversity status.');
    end if;
    for v_consent in select * from app.sensitive_data_consents c
                     where c.account_id = p_account_id and c.category = p_category and c.withdrawn_at is null for update loop
      perform private.close_sensitive_consent(v_consent);
      perform private.write_audit_event(p_account_id, 'sensitive_consent.withdrawn', 'app.sensitive_data_consents', v_consent.id,
        jsonb_build_object('category', p_category));
    end loop;
    return private.erase_sensitive_category(null, p_account_id, p_category);
  end if;
  -- The person's own consent, and anything attested about them in this category, ends together. That includes a guest list
  -- entry that only names their verified email so far.
  perform private.link_guest_needs_to_person(v_me);
  for v_consent in select * from app.sensitive_data_consents c
                   where c.person_id = v_me and c.category = p_category and c.withdrawn_at is null for update loop
    perform private.close_sensitive_consent(v_consent);
  end loop;
  v_erased := private.erase_sensitive_category(v_me, null, p_category);
  perform private.log_work_detail_event(v_me, case when v_erased then 'sensitive_consent.withdrawn' else 'sensitive_consent.withdrawn_on_hold' end,
    null, null, '{}', '{}', null);
  return v_erased;
end;
$$;

comment on function app.withdraw_sensitive_consent(app.sensitive_data_category, uuid) is 'Withdraws a category at once, in one call, also while an org is read-only: the signed-in person''s own consent and anything attested about them, or with an account a company''s attestation. Use stops at once and the values are cleared. Returns false when a legal hold keeps the values, masked, until it ends (ADR 0164).';
revoke all on function app.withdraw_sensitive_consent(app.sensitive_data_category, uuid) from public, anon;
grant execute on function app.withdraw_sensitive_consent(app.sensitive_data_category, uuid) to authenticated, service_role;

-- The person's own view -----------------------------------------------------------------------------------------------

create or replace function app.my_sensitive_consents(p_account_id uuid default null)
returns table (
  category app.sensitive_data_category,
  notice_version text,
  given_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.category, c.notice_version, c.given_at
  from app.sensitive_data_consents c
  where c.withdrawn_at is null
    and ((p_account_id is null and c.person_id = private.current_person_id() and c.basis = 'Own Consent')
      or (p_account_id is not null and c.account_id = p_account_id
          and p_account_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))))
  order by c.category;
$$;

comment on function app.my_sensitive_consents(uuid) is 'The standing grants of the signed-in person, or of a company they are an Owner or Admin of: what the forms check before showing a sensitive field.';
revoke all on function app.my_sensitive_consents(uuid) from public, anon;
grant execute on function app.my_sensitive_consents(uuid) to authenticated, service_role;

-- Account deletion ----------------------------------------------------------------------------------------------------

create or replace function private.erase_sensitive_consents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry uuid;
begin
  -- A guest list holds this outside the person's own rows: close it here. The auth user is deleted after this (1112), so
  -- the verified email still names the entries that hold it.
  perform private.link_guest_needs_to_person(new.id);
  for v_entry in select n.guest_list_entry_id from app.guest_care_needs n where n.guest_person_id = new.id loop
    perform private.close_guest_needs(v_entry);
  end loop;
  update app.guest_care_needs n set guest_person_id = null where n.guest_person_id = new.id;
  update app.sensitive_data_consents c set withdrawn_at = now(), withdrawn_by = new.id
  where c.withdrawn_at is null and (c.person_id = new.id or (c.given_by = new.id and c.basis = 'Own Consent'));
  -- With the account gone their email names nobody, so the entries they said were someone else need not remember them (6852).
  delete from private.guest_needs_disowned d where d.person_id = new.id;
  return null;
end;
$$;

comment on function private.erase_sensitive_consents() is 'After a person is deleted (account deletion, 1112): withdraws every grant about them and deletes what a guest list holds about them under their person or verified email, and which guest entries they said were someone else. The grants stay as evidence. The person''s own values and meal preferences are deleted by the erasures of 1340, 1464 and 4655, and the field records follow. An org''s legal hold on guest needs keeps those values hidden until it ends, no longer linked to the person.';
revoke all on function private.erase_sensitive_consents() from public, anon, authenticated;

create trigger t63_erase_sensitive_consents after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.erase_sensitive_consents();
