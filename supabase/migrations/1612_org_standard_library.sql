-- 1612_org_standard_library.sql
-- WP18 (range 1610 to 1619, RRR-66), finding A65-027, Sections 2.1 and 7.2: the XOS Standard Library is "copied into
-- each new org as editable org data". Each standard row becomes an org row that names its standard source. The org
-- edits, reorders or removes its copies freely, and nothing here ever changes a copy once made:
--   Standard Library (xpms)       org data (app)                  reference to the source
--   std_document_library          documents                       std_document_id (new)
--   emergency_code                emergency_codes (new)           code
--   std_enumeration               enumerations (new)              std_enumeration_id
--   rate_card (Labor Rate Cards)  rate_cards, rate_card_lines     canon_rate_card_id (0341)
--   std_radio_channel             radio_channel_plan (new)        std_radio_channel_id
--   role (Roles Library)          role_library (new)              role_code
--   std_sop                       sops                            std_sop_id (new)
--   std_vendor_class              vendor_classes                  std_vendor_class_id (0330)
--   std_vendor_entitlement        vendor_class_entitlements (new) std_vendor_entitlement_id
--   std_verbiage                  verbiage_terms                  std_verbiage_id (new)
--   * private.adopt_standard_library copies every standard row the org has never held a copy of, so running it again
--     changes nothing and a copy the org removed is not brought back. app.create_organization,
--     app.create_client_organization and app.subscribe_external_account call it, which are the ways an org starts
--     using Atlas; a sandbox is filled from its template instead (1530).
--   * app.adopt_standard_library is the "Adopt Standard Library" action for orgs that existed before this migration
--     (Settings, Canon Extensions; canon.extension.write). app.standard_library_status counts, per library, the
--     standard rows and the org's copies.
--   * Emergency codes become org data with numeric ordering (Section 3.6, Ordering): the org relabels, redescribes
--     and reorders its copy of each code. The code word stays canon, because crisis alerts and the protocols name it
--     (decision D15), so an org holds a copy of a canon code and never invents one. API v1's emergencyCodes keeps
--     serving the global codes unchanged.
--   * SOPs arrive as drafts, so the org reviews each before publishing asks its people to acknowledge it.
-- Recreated from their latest definitions with one added call: app.create_organization and
-- app.subscribe_external_account (1350) and app.create_client_organization (0206).

-- Emergency codes -----------------------------------------------------------------------------------------------------

create table app.emergency_codes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  code text not null references xpms.emergency_code (code),
  label text not null,
  emergency text not null,
  sort_order integer not null,
  deleted_at timestamptz,
  constraint emergency_codes_label_length check (char_length(btrim(label)) between 1 and 100),
  constraint emergency_codes_emergency_length check (char_length(btrim(emergency)) between 1 and 200),
  constraint emergency_codes_sort_order_positive check (sort_order > 0)
);
create unique index emergency_codes_code_key on app.emergency_codes (code, org_id);
create index emergency_codes_org_order_idx on app.emergency_codes (org_id, sort_order) where deleted_at is null;
call private.install_domain_table('app.emergency_codes');
call private.install_policies('app.emergency_codes',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('safety.emergency_code.write'))$$);
call private.describe('app.emergency_codes', 'The org''s emergency codes: its editable copy of the Standard Library codes (xpms.emergency_code, decision D15), listed in sort_order, then code. Every member reads them; safety.emergency_code.write edits them. One row per canon code, kept when removed, so adopting the Standard Library again never brings a removed code back.', array[
  'code', 'Canon code word the row is a copy of, such as CODE_RED. Crisis alerts and protocols name it; its swatch comes from canon.',
  'label', 'The org''s label for the code, such as Code Red.',
  'emergency', 'The emergency the code announces, in the org''s words.',
  'sort_order', 'Position in the org''s list, ascending.'
]);
call private.install_default_retention('app.emergency_codes');

-- References from existing org tables to the rows they were copied from ----------------------------------------------

alter table app.sops add column std_sop_id text references xpms.std_sop (sop_id);
create unique index sops_std_sop_id_key on app.sops (std_sop_id, org_id) where std_sop_id is not null;
comment on column app.sops.std_sop_id is 'Standard Library SOP the row was copied from (xpms.std_sop); NULL for an SOP the org wrote. The org edits its copy freely.';

alter table app.verbiage_terms add column std_verbiage_id text references xpms.std_verbiage (record_id);
create unique index verbiage_terms_std_verbiage_id_key on app.verbiage_terms (std_verbiage_id, org_id) where std_verbiage_id is not null;
comment on column app.verbiage_terms.std_verbiage_id is 'Verbiage Library row the term was copied from (xpms.std_verbiage); NULL for a term the org added.';

alter table app.documents add column std_document_id text references xpms.std_document_library (record_id);
create unique index documents_std_document_id_key on app.documents (std_document_id, org_id) where std_document_id is not null;
comment on column app.documents.std_document_id is 'Document & Asset Library row the document was copied from (xpms.std_document_library); NULL for a document the org added. A copy starts with no version: the org uploads its own file.';

create unique index vendor_classes_std_vendor_class_key on app.vendor_classes (std_vendor_class_id, org_id) where std_vendor_class_id is not null;

-- Vendor entitlements -------------------------------------------------------------------------------------------------

create table app.vendor_class_entitlements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_class_id uuid not null references app.vendor_classes (id),
  module text not null,
  is_permitted boolean not null default true,
  std_vendor_entitlement_id text references xpms.std_vendor_entitlement (record_id),
  deleted_at timestamptz,
  constraint vendor_class_entitlements_module_length check (char_length(btrim(module)) between 1 and 100)
);
create unique index vendor_class_entitlements_module_key on app.vendor_class_entitlements (vendor_class_id, lower(module)) where deleted_at is null;
create unique index vendor_class_entitlements_std_key on app.vendor_class_entitlements (std_vendor_entitlement_id, org_id) where std_vendor_entitlement_id is not null;
call private.install_domain_table('app.vendor_class_entitlements', 'app.vendor_classes', 'vendor_class_id');
call private.install_policies('app.vendor_class_entitlements',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.vendor.write'))$$);
call private.describe('app.vendor_class_entitlements', 'What a vendor class may use on site, one row per module (Advance, Access, Credentials, Parking and so on): the org''s editable copy of the Standard Library vendor entitlements, or its own.', array[
  'vendor_class_id', 'Vendor class the entitlement belongs to.',
  'module', 'Module or on-site service the entitlement covers, such as Parking.',
  'is_permitted', 'True when the class may use the module.',
  'std_vendor_entitlement_id', 'Standard Library entitlement the row was copied from (xpms.std_vendor_entitlement); NULL for the org''s own.'
]);
call private.install_default_retention('app.vendor_class_entitlements');

-- Radio channel plan --------------------------------------------------------------------------------------------------

create table app.radio_channel_plan (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  zone_number integer not null,
  channel_number integer not null,
  assignment text not null,
  std_radio_channel_id text references xpms.std_radio_channel (record_id),
  deleted_at timestamptz,
  constraint radio_channel_plan_zone_positive check (zone_number > 0),
  constraint radio_channel_plan_channel_positive check (channel_number > 0),
  constraint radio_channel_plan_assignment_length check (char_length(btrim(assignment)) between 1 and 100)
);
create unique index radio_channel_plan_channel_key on app.radio_channel_plan (org_id, zone_number, channel_number) where deleted_at is null;
create unique index radio_channel_plan_std_key on app.radio_channel_plan (std_radio_channel_id, org_id) where std_radio_channel_id is not null;
call private.install_domain_table('app.radio_channel_plan');
call private.install_policies('app.radio_channel_plan',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('safety.radio_channel.write'))$$);
call private.describe('app.radio_channel_plan', 'The org''s standard radio plan, by zone and channel number: its editable copy of the Standard Library radio channels, or its own. A project''s own plan is app.radio_channels.', array[
  'zone_number', 'Radio zone, such as 1.',
  'channel_number', 'Channel within the zone, unique per zone.',
  'assignment', 'Who talks on the channel, such as Security.',
  'std_radio_channel_id', 'Standard Library channel the row was copied from (xpms.std_radio_channel); NULL for the org''s own.'
]);
call private.install_default_retention('app.radio_channel_plan');

-- Enumerations --------------------------------------------------------------------------------------------------------

create table app.enumerations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  domain text not null,
  code text not null,
  label text not null,
  description text,
  sort_order integer not null,
  color_code text,
  is_default boolean not null default false,
  std_enumeration_id text references xpms.std_enumeration (record_id),
  deleted_at timestamptz,
  constraint enumerations_domain_length check (char_length(btrim(domain)) between 1 and 100),
  constraint enumerations_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint enumerations_label_length check (char_length(btrim(label)) between 1 and 100),
  constraint enumerations_sort_order_positive check (sort_order > 0),
  constraint enumerations_color_format check (color_code is null or color_code ~ '^#[0-9A-Fa-f]{6}$')
);
create unique index enumerations_code_key on app.enumerations (org_id, domain, code) where deleted_at is null;
create unique index enumerations_std_key on app.enumerations (std_enumeration_id, org_id) where std_enumeration_id is not null;
call private.install_domain_table('app.enumerations');
call private.install_policies('app.enumerations',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('canon.extension.write'))$$);
call private.describe('app.enumerations', 'The org''s enumeration values, by domain and sort_order: its editable copy of the Standard Library enumerations (xpms.std_enumeration), or its own.', array[
  'domain', 'Enumeration domain, such as Incident Severity.',
  'code', 'Value code, such as SEV_CRITICAL.',
  'label', 'The org''s label for the value.',
  'description', 'What the value means.',
  'sort_order', 'Position within the domain, ascending.',
  'color_code', 'Display color as #RRGGBB.',
  'is_default', 'True for the domain''s default value.',
  'std_enumeration_id', 'Standard Library value the row was copied from (xpms.std_enumeration); NULL for the org''s own.'
]);
call private.install_default_retention('app.enumerations');

-- Roles Library -------------------------------------------------------------------------------------------------------

create table app.role_library (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  role_code text not null references xpms.role (role_code),
  job_title text not null,
  job_summary text,
  key_responsibilities text,
  qualifications text,
  physical_requirements text,
  required_certifications text,
  default_clearance_tier text,
  default_radio_channel text,
  deleted_at timestamptz,
  constraint role_library_job_title_length check (char_length(btrim(job_title)) between 1 and 200)
);
create unique index role_library_role_key on app.role_library (role_code, org_id);
call private.install_domain_table('app.role_library');
call private.install_policies('app.role_library',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('people.role.write'))$$);
call private.describe('app.role_library', 'The org''s job descriptions per canon role: its editable copy of the Roles Library (xpms.role, decision D12). Role codes stay canon; the org edits the title and the description. One row per role, kept when removed, so adopting again never brings it back.', array[
  'role_code', 'Canon role code (xpms.role) the row describes.',
  'job_title', 'The org''s job title for the role.',
  'job_summary', 'Summary of the job.',
  'key_responsibilities', 'Key responsibilities.',
  'qualifications', 'Qualifications.',
  'physical_requirements', 'Physical requirements.',
  'required_certifications', 'Certifications the role requires.',
  'default_clearance_tier', 'Clearance tier the role usually carries.',
  'default_radio_channel', 'Radio channel the role usually monitors.'
]);
call private.install_default_retention('app.role_library');

-- Adoption ------------------------------------------------------------------------------------------------------------

create or replace function private.adopt_standard_library(p_org_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
  v_card uuid;
  v_sop record;
  v_code text;
begin
  -- One adoption at a time per org, so two concurrent runs never copy a row twice.
  perform 1 from app.organizations o where o.id = p_org_id for update;
  if not found then
    perform private.refuse('org_not_found', 'No such organization.');
  end if;

  insert into app.documents (org_id, title, std_document_id)
  select p_org_id, s.document_name, s.record_id from xpms.std_document_library s
  where s.document_name is not null
    and not exists (select 1 from app.documents d where d.org_id = p_org_id and d.std_document_id = s.record_id)
  order by s.source_row;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('document_library', v_n);

  insert into app.emergency_codes (org_id, code, label, emergency, sort_order)
  select p_org_id, s.code, s.label, s.emergency, s.sort_order from xpms.emergency_code s
  where not exists (select 1 from app.emergency_codes c where c.org_id = p_org_id and c.code = s.code)
  order by s.sort_order;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('emergency_codes', v_n);

  insert into app.enumerations (org_id, domain, code, label, description, sort_order, color_code, is_default, std_enumeration_id)
  select p_org_id, s.enum_domain, s.enum_code, s.enum_label, s.description, s.sort_order::integer, s.color_code,
    coalesce(s.is_default, false), s.record_id
  from xpms.std_enumeration s
  where not exists (select 1 from app.enumerations e where e.org_id = p_org_id and e.std_enumeration_id = s.record_id)
  order by s.source_row
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('enumerations', v_n);

  -- Labor rate cards: the standard lines go on one org rate card, the one already holding standard lines if any.
  if exists (select 1 from xpms.rate_card s
             where not exists (select 1 from app.rate_card_lines l where l.org_id = p_org_id and l.canon_rate_card_id = s.rate_card_id)) then
    select l.rate_card_id into v_card from app.rate_card_lines l
    join app.rate_cards c on c.id = l.rate_card_id and c.deleted_at is null
    where l.org_id = p_org_id and l.canon_rate_card_id is not null
    order by c.created_at limit 1;
    if v_card is null then
      insert into app.rate_cards (org_id, name, currency_code, effective_from)
      values (p_org_id, 'XOS Standard Labor Rates', 'USD', private.org_today(p_org_id))
      returning id into v_card;
    end if;
    insert into app.rate_card_lines (org_id, rate_card_id, role_code, worker_classification, pay_basis, arrangement,
      canon_rate_card_id, overtime_rule_id, rate_minor)
    select p_org_id, v_card, s.role_code, s.worker_classification, s.pay_basis, s.arrangement, s.rate_card_id,
      s.overtime_rule_id, s.standard_rate_minor
    from xpms.rate_card s
    where not exists (select 1 from app.rate_card_lines l where l.org_id = p_org_id and l.canon_rate_card_id = s.rate_card_id)
    order by s.rate_card_id
    on conflict do nothing;
    get diagnostics v_n = row_count;
  else
    v_n := 0;
  end if;
  v_counts := v_counts || jsonb_build_object('labor_rate_cards', v_n);

  insert into app.radio_channel_plan (org_id, zone_number, channel_number, assignment, std_radio_channel_id)
  select p_org_id, s.zone::integer, s.channel::integer, s.assignment, s.record_id from xpms.std_radio_channel s
  where s.zone is not null and s.channel is not null and s.assignment is not null
    and not exists (select 1 from app.radio_channel_plan r where r.org_id = p_org_id and r.std_radio_channel_id = s.record_id)
  order by s.source_row
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('radio_channels', v_n);

  insert into app.role_library (org_id, role_code, job_title, job_summary, key_responsibilities, qualifications,
    physical_requirements, required_certifications, default_clearance_tier, default_radio_channel)
  select p_org_id, s.role_code, s.job_title, s.job_summary, s.key_responsibilities, s.qualifications,
    s.physical_requirements, s.required_certifications, s.default_clearance_tier, s.default_radio_channel
  from xpms.role s
  where not exists (select 1 from app.role_library r where r.org_id = p_org_id and r.role_code = s.role_code)
  order by s.role_code;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('roles', v_n);

  -- SOPs, as drafts. A copy whose code the org already uses takes the next free SOP code.
  v_n := 0;
  for v_sop in
    select s.* from xpms.std_sop s
    where s.title is not null
      and not exists (select 1 from app.sops o where o.org_id = p_org_id and o.std_sop_id = s.sop_id)
    order by s.sop_id
  loop
    v_code := v_sop.sop_id;
    if exists (select 1 from app.sops o where o.org_id = p_org_id and o.code = v_code and o.deleted_at is null) then
      select format('SOP-%s', lpad((coalesce(max(substring(o.code from 5)::integer), 0) + 1)::text, 3, '0')) into v_code
      from app.sops o where o.org_id = p_org_id and o.deleted_at is null;
    end if;
    insert into app.sops (org_id, code, title, body, std_sop_id)
    values (p_org_id, v_code, v_sop.title,
      coalesce(nullif(concat_ws(E'\n\n', v_sop.prerequisites_and_hazards,
        nullif(concat_ws(E'\n', '1. ' || v_sop.procedure_step_1, '2. ' || v_sop.procedure_step_2,
          '3. ' || v_sop.procedure_step_3, '4. ' || v_sop.procedure_step_4), '')), ''), v_sop.title),
      v_sop.sop_id);
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('sops', v_n);

  -- Vendor classes; a class whose name the org already uses keeps the org's own and is not copied.
  insert into app.vendor_classes (org_id, name, description, std_vendor_class_id)
  select p_org_id, s.class, s.description, s.record_id from xpms.std_vendor_class s
  where s.class is not null
    and not exists (select 1 from app.vendor_classes c where c.org_id = p_org_id and c.std_vendor_class_id = s.record_id)
  order by s.source_row
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('vendor_classes', v_n);

  insert into app.vendor_class_entitlements (org_id, vendor_class_id, module, is_permitted, std_vendor_entitlement_id)
  select p_org_id, c.id, s.module, coalesce(s.permitted, false), s.record_id
  from xpms.std_vendor_entitlement s
  join app.vendor_classes c on c.org_id = p_org_id and c.std_vendor_class_id = s.vendor_class and c.deleted_at is null
  where s.module is not null
    and not exists (select 1 from app.vendor_class_entitlements e where e.org_id = p_org_id and e.std_vendor_entitlement_id = s.record_id)
  order by s.source_row
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('vendor_entitlements', v_n);

  -- Verbiage; a term the org already has keeps the org's own.
  insert into app.verbiage_terms (org_id, term, casing_rule, definition, std_verbiage_id)
  select p_org_id, s.verbiage,
    case when s.verbiage = upper(s.verbiage) then 'All caps' else 'As written' end,
    rtrim(coalesce(s.description, s.title, s.verbiage), '.') || '.', s.record_id
  from xpms.std_verbiage s
  where s.verbiage is not null
    and not exists (select 1 from app.verbiage_terms v where v.org_id = p_org_id and v.std_verbiage_id = s.record_id)
  order by s.source_row
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('verbiage', v_n);

  return v_counts;
end;
$$;

comment on function private.adopt_standard_library(uuid) is 'Copies into the org every XOS Standard Library row it has never held a copy of, each as org data naming its standard source (Section 7.2, finding A65-027). Never changes or restores an existing copy, so a second run copies nothing. SOPs arrive as drafts; an SOP code the org already uses takes the next free code, and a vendor class or verbiage term the org already has keeps the org''s own. Returns the rows copied per library.';
revoke all on function private.adopt_standard_library(uuid) from public, anon, authenticated;

create or replace function app.adopt_standard_library(p_org_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'canon.extension.write') then
    raise exception using errcode = '42501', message = 'canon.extension.write is required';
  end if;
  return private.adopt_standard_library(p_org_id);
end;
$$;

comment on function app.adopt_standard_library(uuid) is 'The "Adopt Standard Library" action (Settings, Canon Extensions): copies into an existing org the Standard Library rows it has never held, without changing any copy it holds or bringing back one it removed. Needs canon.extension.write. Returns the rows copied per library; all zero when nothing is left to copy.';
revoke all on function app.adopt_standard_library(uuid) from public, anon;
grant execute on function app.adopt_standard_library(uuid) to authenticated, service_role;

create or replace function app.standard_library_status(p_org_id uuid)
returns table (library text, standard_count integer, adopted_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.settings.read') then
    raise exception using errcode = '42501', message = 'org.settings.read is required';
  end if;
  return query
  select l.library, l.standard_count::integer, l.adopted_count::integer from (values
    (1, 'document_library', (select count(*) from xpms.std_document_library),
      (select count(*) from app.documents d where d.org_id = p_org_id and d.std_document_id is not null)),
    (2, 'emergency_codes', (select count(*) from xpms.emergency_code),
      (select count(*) from app.emergency_codes c where c.org_id = p_org_id)),
    (3, 'enumerations', (select count(*) from xpms.std_enumeration),
      (select count(*) from app.enumerations e where e.org_id = p_org_id and e.std_enumeration_id is not null)),
    (4, 'labor_rate_cards', (select count(*) from xpms.rate_card),
      (select count(distinct l.canon_rate_card_id) from app.rate_card_lines l where l.org_id = p_org_id)),
    (5, 'radio_channels', (select count(*) from xpms.std_radio_channel),
      (select count(*) from app.radio_channel_plan r where r.org_id = p_org_id and r.std_radio_channel_id is not null)),
    (6, 'roles', (select count(*) from xpms.role),
      (select count(*) from app.role_library r where r.org_id = p_org_id)),
    (7, 'sops', (select count(*) from xpms.std_sop),
      (select count(*) from app.sops s where s.org_id = p_org_id and s.std_sop_id is not null)),
    (8, 'vendor_classes', (select count(*) from xpms.std_vendor_class),
      (select count(*) from app.vendor_classes c where c.org_id = p_org_id and c.std_vendor_class_id is not null)),
    (9, 'vendor_entitlements', (select count(*) from xpms.std_vendor_entitlement),
      (select count(*) from app.vendor_class_entitlements e where e.org_id = p_org_id and e.std_vendor_entitlement_id is not null)),
    (10, 'verbiage', (select count(*) from xpms.std_verbiage),
      (select count(*) from app.verbiage_terms v where v.org_id = p_org_id and v.std_verbiage_id is not null))
  ) as l (ordinal, library, standard_count, adopted_count)
  order by l.ordinal;
end;
$$;

comment on function app.standard_library_status(uuid) is 'Per Standard Library, how many standard rows exist and how many the org holds or held a copy of, in the order of Section 7.2. Needs org.settings.read.';
revoke all on function app.standard_library_status(uuid) from public, anon;
grant execute on function app.standard_library_status(uuid) to authenticated, service_role;

-- Every org that starts using Atlas adopts the Standard Library ---------------------------------------------------------

create or replace function app.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_membership uuid;
begin
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug) values (btrim(p_name), p_slug) returning id into v_org;
  perform private.start_trial(v_org, private.trial_plan(), private.org_window_end(v_org, private.trial_days()),
    'Organization created: a 14-day Pro trial with no card.');

  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (v_org, v_person) returning id into v_membership;
  insert into app.membership_roles (membership_id, role_id, granted_by)
  values (v_membership, private.system_role_id('owner'), null);
  perform private.end_trusted_operation('membership_write');
  perform private.adopt_standard_library(v_org);
  return v_org;
end;
$$;

comment on function app.create_organization(text, text) is 'Creates an organization with the signed-in person as its Owner, in one transaction. It starts a 14-day Pro trial with no card and moves to the Access plan when the trial ends unless a card is added (Section 14.7), and receives its editable copy of the XOS Standard Library (Section 7.2). Returns the org id.';
revoke all on function app.create_organization(text, text) from public, anon;
grant execute on function app.create_organization(text, text) to authenticated, service_role;

create or replace function app.create_client_organization(
  p_partner_org_id uuid,
  p_name text,
  p_slug text,
  p_owner_email text,
  p_plan_code text default 'access'
)
returns table (org_id uuid, invite_id uuid, invite_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_token text := private.issue_invite_token();
  v_invite uuid;
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, parent_org_id)
  values (btrim(p_name), p_slug, p_partner_org_id)
  returning id into v_org;
  perform private.create_subscription(v_org, p_plan_code);
  insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by, partner_bootstrap)
  values (v_org, lower(btrim(p_owner_email)), private.system_role_id('owner'), private.invite_token_hash(v_token),
          now() + interval '14 days', v_person, true)
  returning id into v_invite;
  perform private.adopt_standard_library(v_org);
  return query select v_org, v_invite, v_token;
end;
$$;

comment on function app.create_client_organization(uuid, text, text, text, text) is 'Partner console (Section 4.6.1): creates a client org under the partner on the given plan, with its editable copy of the XOS Standard Library (Section 7.2), and an Owner invite for the client. Partner staff gain no access to the client org. The token is returned once.';
revoke all on function app.create_client_organization(uuid, text, text, text, text) from public, anon;
grant execute on function app.create_client_organization(uuid, text, text, text, text) to authenticated, service_role;

create or replace function app.subscribe_external_account(p_account_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if p_account_id is null
     or p_account_id not in (select private.my_account_ids(array['Account Owner']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'only the account''s Account Owner subscribes it';
  end if;
  perform 1 from app.organizations o where o.id = p_account_id and o.deleted_at is null for update;
  if exists (select 1 from app.subscriptions s where s.org_id = p_account_id and s.deleted_at is null) then
    perform private.refuse('account_already_subscribed', 'This company already uses Atlas; open it from the organization switcher.');
  end if;
  perform private.start_trial(p_account_id, private.trial_plan(), private.org_window_end(p_account_id, private.trial_days()),
    'External account started using Atlas: a 14-day Pro trial with no card.');

  perform private.begin_trusted_operation('membership_write');
  with m as (
    insert into app.memberships (org_id, person_id) values (p_account_id, v_person) returning id
  )
  insert into app.membership_roles (membership_id, role_id, granted_by)
  select m.id, private.system_role_id('owner'), null from m;
  perform private.end_trusted_operation('membership_write');
  perform private.adopt_standard_library(p_account_id);
  return p_account_id;
end;
$$;

comment on function app.subscribe_external_account(uuid) is 'Journey 60: the Account Owner of an external account starts using Atlas with it. Starts a 14-day Pro trial with no card (Section 14.7), makes the caller the Owner of the same organization row, so its profile, ratings, engagements and counterparty history carry over with no duplicate, and gives it its editable copy of the XOS Standard Library (Section 7.2). Refuses account_already_subscribed (XR001) for an org that already subscribes; anyone but an Account Owner gets 42501.';
revoke all on function app.subscribe_external_account(uuid) from public, anon;
grant execute on function app.subscribe_external_account(uuid) to authenticated, service_role;
