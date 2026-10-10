-- 0352_assets_credentials.sql
-- A03 Domain Data. Assets (Section 7.4 Assets, Section 3.9 grain): asset classes bound to elements,
-- units with asset tags and the nine-value asset lifecycle (Section 3.12, lifecycle 3), lots,
-- external identifiers, the custody ledger, maintenance and damage. Credentials (Section 7.4
-- Credentials, invariant 21): credential categories, issued credentials never self-issued, the access
-- grid (zone by category with time windows), access scans, certifications and holders that verify
-- publicly only with the holder's consent.

-- Assets ------------------------------------------------------------------------------------------------

create type app.asset_state as enum (
  'Proposed', 'Received', 'Available', 'Reserved', 'Deployed', 'In Maintenance', 'Damaged', 'Lost', 'Retired'
);
comment on type app.asset_state is 'The nine-value asset lifecycle (Section 7.4, Section 3.12 lifecycle 3). Retired is terminal; retiring needs assets.write_off.approve.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('asset', 'Proposed', 'Received'),
  ('asset', 'Received', 'Available'),
  ('asset', 'Available', 'Reserved'),
  ('asset', 'Available', 'Deployed'),
  ('asset', 'Available', 'In Maintenance'),
  ('asset', 'Available', 'Retired'),
  ('asset', 'Reserved', 'Available'),
  ('asset', 'Reserved', 'Deployed'),
  ('asset', 'Deployed', 'Available'),
  ('asset', 'Deployed', 'Damaged'),
  ('asset', 'Deployed', 'Lost'),
  ('asset', 'In Maintenance', 'Available'),
  ('asset', 'In Maintenance', 'Retired'),
  ('asset', 'Damaged', 'In Maintenance'),
  ('asset', 'Damaged', 'Retired'),
  ('asset', 'Lost', 'Available'),
  ('asset', 'Lost', 'Retired');

insert into private.domain_event_types (code, subject, description) values
  ('asset.state_changed', 'asset_units', 'An asset unit moved to another asset state.'),
  ('asset.custody_changed', 'asset_units', 'An asset unit changed custody.'),
  ('credential.issued', 'credentials', 'A credential was issued to a person.'),
  ('credential.revoked', 'credentials', 'A credential was revoked.');

create table app.asset_classes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  element_id text not null references xpms.elements (element_id),
  name text not null,
  deleted_at timestamptz,
  constraint asset_classes_name_length check (char_length(btrim(name)) between 1 and 200)
);
create index asset_classes_element_id_idx on app.asset_classes (element_id);
create unique index asset_classes_org_element_key on app.asset_classes (org_id, element_id) where deleted_at is null;
call private.install_domain_table('app.asset_classes');
call private.install_policies('app.asset_classes',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.asset.write'))$$);
call private.describe('app.asset_classes', 'Asset classes (Section 3.9 class grain): what a kind of owned equipment is, bound to its canon element, one per element per org.', array[
  'element_id', 'Canon element the class is.', 'name', 'Name the org uses.'
]);

create table app.asset_units (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_class_id uuid not null references app.asset_classes (id),
  asset_tag text not null,
  asset_state app.asset_state not null default 'Proposed',
  condition_enum_id text references xpms.std_enumeration (record_id),
  home_venue_id uuid references app.venues (id),
  deleted_at timestamptz,
  constraint asset_units_tag_format check (asset_tag ~ '^[A-Z0-9][A-Z0-9-]{1,31}$')
);
create index asset_units_class_idx on app.asset_units (asset_class_id);
create index asset_units_condition_idx on app.asset_units (condition_enum_id);
create index asset_units_home_venue_idx on app.asset_units (home_venue_id);
create unique index asset_units_tag_key on app.asset_units (org_id, asset_tag) where deleted_at is null;
call private.install_domain_table('app.asset_units', 'app.asset_classes', 'asset_class_id', array['app.venues', 'home_venue_id']);
call private.describe('app.asset_units', 'Individual assets (Section 3.9 unit grain) tracked by asset tag, with the nine-value lifecycle.', array[
  'asset_class_id', 'Class of the unit.', 'asset_tag', 'Asset tag, a code of ours unique within the org.', 'asset_state', 'Lifecycle state. Changes only through app.transition_asset.',
  'condition_enum_id', 'Condition: a row of the canon Asset Condition enumeration.', 'home_venue_id', 'Venue the unit returns to.'
]);
call private.install_lifecycle('app.asset_units', 'asset_unit_id', 'asset_state', 'asset', 'Proposed',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$);
create trigger t90_emit_asset_state after insert on app.asset_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('asset.state_changed', 'asset_units', 'asset_unit_id', 'from_state', 'to_state', 'reason');

create or replace function private.guard_asset_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_enumeration(new.condition_enum_id, 'Asset Condition');
  if tg_op = 'UPDATE' and new.asset_tag <> old.asset_tag then
    perform private.refuse('asset_tag_immutable', 'An asset keeps its tag.');
  end if;
  return new;
end;
$$;
comment on function private.guard_asset_unit() is 'Asset units: canon condition values and a fixed asset tag.';
revoke all on function private.guard_asset_unit() from public, anon, authenticated;
create trigger t40_guard_asset_unit before insert or update on app.asset_units for each row execute function private.guard_asset_unit();

create or replace function app.transition_asset(p_asset_unit_id uuid, p_expected app.asset_state, p_next app.asset_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select a.org_id from app.asset_units a where a.id = p_asset_unit_id);
  v_capability text := case when p_next = 'Retired' then 'assets.write_off.approve' else 'assets.asset.write' end;
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required', v_capability);
  end if;
  return private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
    'asset_unit_id', p_asset_unit_id, p_expected::text, p_next::text, p_reason);
end;
$$;
comment on function app.transition_asset(uuid, app.asset_state, app.asset_state, text) is 'Moves an asset along its nine-value lifecycle with compare-and-set; retiring needs assets.write_off.approve, the rest assets.asset.write.';
revoke all on function app.transition_asset(uuid, app.asset_state, app.asset_state, text) from public, anon;
grant execute on function app.transition_asset(uuid, app.asset_state, app.asset_state, text) to authenticated, service_role;

create table app.asset_lots (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_class_id uuid not null references app.asset_classes (id),
  venue_id uuid not null references app.venues (id),
  quantity numeric not null,
  deleted_at timestamptz,
  constraint asset_lots_quantity_nonnegative check (quantity >= 0)
);
create index asset_lots_class_idx on app.asset_lots (asset_class_id);
create index asset_lots_venue_idx on app.asset_lots (venue_id);
create unique index asset_lots_place_key on app.asset_lots (asset_class_id, venue_id) where deleted_at is null;
call private.install_domain_table('app.asset_lots', 'app.asset_classes', 'asset_class_id', array['app.venues', 'venue_id']);
call private.describe('app.asset_lots', 'A quantity of an asset class at a place (Section 3.9 lot grain).', array[
  'asset_class_id', 'Class counted.', 'venue_id', 'Place the lot sits.', 'quantity', 'Quantity on hand.'
]);

create table app.asset_identifiers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_unit_id uuid not null references app.asset_units (id),
  identifier_class text not null default 'identifier' references xpms.dim_identifier_class (class),
  scheme text not null,
  value text not null,
  deleted_at timestamptz,
  constraint asset_identifiers_external check (identifier_class = 'identifier'),
  constraint asset_identifiers_scheme_format check (scheme ~ '^[a-z][a-z0-9_]{1,31}$')
);
create index asset_identifiers_unit_idx on app.asset_identifiers (asset_unit_id);
create index asset_identifiers_class_idx on app.asset_identifiers (identifier_class);
create unique index asset_identifiers_value_key on app.asset_identifiers (org_id, scheme, value) where deleted_at is null;
call private.install_domain_table('app.asset_identifiers', 'app.asset_units', 'asset_unit_id');
call private.describe('app.asset_identifiers', 'Identifiers an external authority issued for an asset unit (serial, GTIN, MPN): recorded and validated, never minted (Section 3.6).', array[
  'asset_unit_id', 'Asset unit.', 'identifier_class', 'Always identifier: the canon class of externally issued values.', 'scheme', 'Scheme, such as serial or gtin14.', 'value', 'The identifier as issued.'
]);

create table app.asset_custody (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_unit_id uuid not null references app.asset_units (id),
  custodian_membership_id uuid references app.memberships (id),
  project_id uuid references app.projects (id),
  venue_id uuid references app.venues (id),
  note text,
  constraint asset_custody_somewhere check (num_nonnulls(custodian_membership_id, venue_id) >= 1)
);
create index asset_custody_unit_idx on app.asset_custody (asset_unit_id);
create index asset_custody_custodian_idx on app.asset_custody (custodian_membership_id);
create index asset_custody_project_idx on app.asset_custody (project_id);
create index asset_custody_venue_idx on app.asset_custody (venue_id);
call private.install_domain_table('app.asset_custody', 'app.asset_units', 'asset_unit_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id', 'app.venues', 'venue_id'], true);
call private.describe('app.asset_custody', 'Append-only custody ledger: each row hands an asset unit to a person or place, optionally for a project. The current custodian is the latest row.', array[
  'asset_unit_id', 'Asset unit.', 'custodian_membership_id', 'Member who holds the asset.', 'project_id', 'Project the asset is out for.', 'venue_id', 'Place the asset is kept.', 'note', 'Handover note.'
]);
create trigger t90_emit_custody after insert on app.asset_custody
  for each row execute function private.emit_subject_event('asset.custody_changed', 'asset_units', 'asset_unit_id', 'custodian_membership_id', 'venue_id', 'project_id');

create table app.asset_maintenance (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_unit_id uuid not null references app.asset_units (id),
  performed_on date not null,
  description text not null,
  cost_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint asset_maintenance_cost_currency check (cost_minor is null or currency_code is not null)
);
create index asset_maintenance_unit_idx on app.asset_maintenance (asset_unit_id);
create index asset_maintenance_currency_idx on app.asset_maintenance (currency_code);
call private.install_domain_table('app.asset_maintenance', 'app.asset_units', 'asset_unit_id');
call private.describe('app.asset_maintenance', 'Maintenance performed on an asset unit. An unknown cost stays NULL.', array[
  'asset_unit_id', 'Asset unit.', 'performed_on', 'Day of the work.', 'description', 'Work done.', 'cost_minor', 'Cost in minor units; NULL when unknown.', 'currency_code', 'ISO 4217 currency.'
]);

create table app.asset_damage (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  asset_unit_id uuid not null references app.asset_units (id),
  project_id uuid references app.projects (id),
  responsible_counterparty_id uuid references app.counterparties (id),
  reported_at timestamptz not null default now(),
  description text not null,
  deleted_at timestamptz
);
create index asset_damage_unit_idx on app.asset_damage (asset_unit_id);
create index asset_damage_project_idx on app.asset_damage (project_id);
create index asset_damage_counterparty_idx on app.asset_damage (responsible_counterparty_id);
call private.install_domain_table('app.asset_damage', 'app.asset_units', 'asset_unit_id', array['app.projects', 'project_id', 'app.counterparties', 'responsible_counterparty_id']);
call private.describe('app.asset_damage', 'Damage reports against an asset unit.', array[
  'asset_unit_id', 'Asset unit.', 'project_id', 'Project during which the damage happened.', 'responsible_counterparty_id', 'Party responsible, when known.', 'reported_at', 'When it was reported.', 'description', 'What happened.'
]);

call private.install_policies('app.asset_units',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.asset.write'))$$);
call private.install_policies('app.asset_lots',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.asset.write'))$$);
call private.install_policies('app.asset_identifiers',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.asset.write'))$$);
call private.install_policies('app.asset_custody',
  $$org_id in (select private.orgs_with_capability('assets.asset.read')) or custodian_membership_id in (select private.my_membership_ids())$$,
  $$org_id in (select private.orgs_with_capability('assets.custody.write')) or project_id in (select private.project_ids_with('assets.custody.write'))$$);
revoke update on app.asset_custody from authenticated;
drop policy asset_custody_update on app.asset_custody;
call private.install_policies('app.asset_maintenance',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.maintenance.write'))$$);
call private.install_policies('app.asset_damage',
  $$org_id in (select private.orgs_with_capability('assets.asset.read'))$$,
  $$org_id in (select private.orgs_with_capability('assets.damage.write')) or project_id in (select private.project_ids_with('assets.damage.write'))$$);

-- Credentials (invariant 21) ---------------------------------------------------------------------------------

create table app.credential_categories (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  code text not null,
  name text not null,
  deleted_at timestamptz,
  constraint credential_categories_code_format check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  constraint credential_categories_name_length check (char_length(btrim(name)) between 1 and 100)
);
create unique index credential_categories_code_key on app.credential_categories (project_id, code) where deleted_at is null;
call private.install_project_table('app.credential_categories', 'credentials.credential.read', 'credentials.category.write');
call private.describe('app.credential_categories', 'Credential categories of a project, such as ALL-ACCESS or CREW. Listed in code order.', array[
  'project_id', 'Project.', 'code', 'Category code, unique per project.', 'name', 'Category name.'
]);

create table app.credentials (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  credential_category_id uuid not null references app.credential_categories (id),
  holder_person_id uuid not null references app.people (id),
  credential_number text not null default '',
  issued_by uuid references app.people (id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint credentials_validity check (valid_to is null or valid_to > valid_from),
  constraint credentials_revoke_pair check ((revoked_at is null) = (revoked_by is null))
);
create index credentials_category_idx on app.credentials (credential_category_id);
create index credentials_holder_idx on app.credentials (holder_person_id);
create index credentials_issued_by_idx on app.credentials (issued_by);
create index credentials_revoked_by_idx on app.credentials (revoked_by);
create unique index credentials_number_key on app.credentials (org_id, credential_number);
call private.install_domain_table('app.credentials', 'app.credential_categories', 'credential_category_id');
call private.describe('app.credentials', 'Credentials issued to people. A person never issues their own credential (invariant 21); revocation is stamped and final.', array[
  'credential_category_id', 'Category issued.', 'holder_person_id', 'Person holding the credential.', 'credential_number', 'Number printed and scanned, issued by the database.',
  'issued_by', 'Person who issued it, from the session; never the holder.', 'valid_from', 'When it starts working.', 'valid_to', 'When it stops working.',
  'revoked_at', 'When it was revoked.', 'revoked_by', 'Who revoked it.'
]);

create or replace function private.guard_credential()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.issued_by := private.current_person_id();
    end if;
    if new.issued_by = new.holder_person_id then
      perform private.refuse('credential_self_issue', 'A person never issues their own credential or certification.');
    end if;
    new.credential_number := 'CR-' || lpad(private.next_sequence(new.org_id, 'credential')::text, 6, '0');
    new.revoked_at := null;
    new.revoked_by := null;
    return new;
  end if;
  if new.holder_person_id <> old.holder_person_id or new.issued_by is distinct from old.issued_by
     or new.credential_number <> old.credential_number or new.credential_category_id <> old.credential_category_id then
    perform private.refuse('credential_immutable', 'A credential keeps its holder, issuer, number and category.');
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at) then
    perform private.refuse('credential_revoked', 'A revoked credential stays revoked; issue a new one.');
  end if;
  if new.revoked_at is not null and old.revoked_at is null then
    if auth.uid() is not null and not private.can_on_project(
        (select c.project_id from app.credential_categories c where c.id = new.credential_category_id), 'credentials.credential.revoke') then
      raise exception using errcode = '42501', message = 'credentials.credential.revoke is required';
    end if;
    new.revoked_at := now();
    new.revoked_by := private.current_person_id();
  end if;
  return new;
end;
$$;
comment on function private.guard_credential() is 'Credentials: issuer from the session and never the holder (invariant 21), number from the org sequence, fixed identity, revocation needs credentials.credential.revoke and is final.';
revoke all on function private.guard_credential() from public, anon, authenticated;
create trigger t40_guard_credential before insert or update on app.credentials for each row execute function private.guard_credential();
create trigger t90_emit_credential_issued after insert on app.credentials
  for each row execute function private.emit_subject_event('credential.issued', 'credentials', 'id', 'credential_category_id', 'holder_person_id');
create trigger t90_emit_credential_revoked after update on app.credentials
  for each row when (old.revoked_at is null and new.revoked_at is not null)
  execute function private.emit_subject_event('credential.revoked', 'credentials', 'id', 'revoked_at');

create table app.access_grid (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  credential_category_id uuid not null references app.credential_categories (id),
  zone_id uuid not null references app.zones (id),
  access_level_enum_id text not null references xpms.std_enumeration (record_id),
  window_starts_at timestamptz not null,
  window_ends_at timestamptz not null,
  deleted_at timestamptz,
  constraint access_grid_window check (window_ends_at > window_starts_at)
);
create index access_grid_category_idx on app.access_grid (credential_category_id);
create index access_grid_zone_idx on app.access_grid (zone_id);
create index access_grid_level_idx on app.access_grid (access_level_enum_id);
call private.install_domain_table('app.access_grid', 'app.credential_categories', 'credential_category_id', array['app.zones', 'zone_id']);
call private.describe('app.access_grid', 'The access grid (Section 7.4): which credential category may enter which zone, at what canon access level, during which time window.', array[
  'credential_category_id', 'Credential category.', 'zone_id', 'Zone of the same org.', 'access_level_enum_id', 'Access level: a row of the canon Access Level enumeration.',
  'window_starts_at', 'When access opens.', 'window_ends_at', 'When access closes.'
]);

create or replace function private.guard_access_grid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_enumeration(new.access_level_enum_id, 'Access Level');
  return new;
end;
$$;
comment on function private.guard_access_grid() is 'Access levels come from the canon Access Level enumeration.';
revoke all on function private.guard_access_grid() from public, anon, authenticated;
create trigger t40_guard_access_grid before insert or update on app.access_grid for each row execute function private.guard_access_grid();

create type app.scan_result as enum ('Granted', 'Denied');
comment on type app.scan_result is 'Outcome of an access scan, decided by the database at scan time.';

create table app.access_scans (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  credential_id uuid not null references app.credentials (id),
  zone_id uuid not null references app.zones (id),
  scanned_at timestamptz not null default now(),
  result app.scan_result not null default 'Denied'
);
create index access_scans_credential_idx on app.access_scans (credential_id, scanned_at);
create index access_scans_zone_idx on app.access_scans (zone_id, scanned_at);
call private.install_domain_table('app.access_scans', 'app.credentials', 'credential_id', array['app.zones', 'zone_id'], true);
call private.describe('app.access_scans', 'Append-only log of credential scans at zones. The result is decided by the database from the credential and the access grid at the scan time, never by the scanner.', array[
  'credential_id', 'Credential scanned.', 'zone_id', 'Zone entered.', 'scanned_at', 'When the scan happened, set by the database.', 'result', 'Granted or Denied.'
]);

create or replace function private.decide_access_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.scanned_at := now();
  new.result := case when exists (
    select 1 from app.credentials c
    join app.access_grid g on g.credential_category_id = c.credential_category_id and g.deleted_at is null
    where c.id = new.credential_id and c.revoked_at is null and c.deleted_at is null
      and c.valid_from <= now() and (c.valid_to is null or c.valid_to > now())
      and g.zone_id = new.zone_id and g.window_starts_at <= now() and g.window_ends_at > now()
  ) then 'Granted'::app.scan_result else 'Denied'::app.scan_result end;
  return new;
end;
$$;
comment on function private.decide_access_scan() is 'Decides an access scan from the credential''s validity and revocation and the access grid at the database time.';
revoke all on function private.decide_access_scan() from public, anon, authenticated;
create trigger t40_decide_access_scan before insert on app.access_scans for each row execute function private.decide_access_scan();

create table app.certifications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  issuing_body text not null,
  deleted_at timestamptz,
  constraint certifications_name_length check (char_length(btrim(name)) between 1 and 200)
);
create unique index certifications_org_name_key on app.certifications (org_id, lower(name)) where deleted_at is null;
call private.install_domain_table('app.certifications');
call private.describe('app.certifications', 'Certifications an org tracks, such as rigging or first aid.', array[
  'name', 'Certification name.', 'issuing_body', 'Body that issues it.'
]);

create table app.certification_holders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  certification_id uuid not null references app.certifications (id),
  person_id uuid not null references app.people (id),
  verified_by uuid references app.people (id),
  issued_on date not null,
  expires_on date,
  verification_code text not null default '',
  public_verification_consented boolean not null default false,
  deleted_at timestamptz,
  constraint certification_holders_validity check (expires_on is null or expires_on >= issued_on)
);
create index certification_holders_certification_idx on app.certification_holders (certification_id);
create index certification_holders_person_idx on app.certification_holders (person_id);
create index certification_holders_verified_by_idx on app.certification_holders (verified_by);
create unique index certification_holders_code_key on app.certification_holders (verification_code);
call private.install_domain_table('app.certification_holders', 'app.certifications', 'certification_id');
call private.describe('app.certification_holders', 'People holding a certification. Recorded by someone other than the holder (invariant 21); a certificate verifies publicly through its code only while the holder consents.', array[
  'certification_id', 'Certification held.', 'person_id', 'Holder.', 'verified_by', 'Person who recorded and verified it; never the holder.',
  'issued_on', 'Day issued.', 'expires_on', 'Day it expires.', 'verification_code', 'Random public verification code, issued by the database.',
  'public_verification_consented', 'True when the holder consents to public verification; only the holder may change it.'
]);

create or replace function private.guard_certification_holder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.verified_by := v_me;
    end if;
    if new.verified_by = new.person_id then
      perform private.refuse('credential_self_issue', 'A person never issues their own credential or certification.');
    end if;
    new.verification_code := encode(extensions.gen_random_bytes(12), 'hex');
    new.public_verification_consented := false;
    return new;
  end if;
  if new.person_id <> old.person_id or new.verified_by is distinct from old.verified_by or new.verification_code <> old.verification_code then
    perform private.refuse('certification_holder_immutable', 'A certification record keeps its holder, verifier and code.');
  end if;
  if new.public_verification_consented <> old.public_verification_consented and auth.uid() is not null and v_me is distinct from new.person_id then
    perform private.refuse('certification_consent_holder_only', 'Only the holder consents to public verification.');
  end if;
  return new;
end;
$$;
comment on function private.guard_certification_holder() is 'Certification holders: recorded by someone other than the holder (invariant 21), with a database-issued code; only the holder changes consent to public verification.';
revoke all on function private.guard_certification_holder() from public, anon, authenticated;
create trigger t40_guard_certification_holder before insert or update on app.certification_holders
  for each row execute function private.guard_certification_holder();

create or replace function api_public.verify_certification(p_verification_code text)
returns table (holder_name text, certification text, issuing_body text, expires_on date)
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name, c.name, c.issuing_body, h.expires_on
  from app.certification_holders h
  join app.certifications c on c.id = h.certification_id and c.deleted_at is null
  join app.people p on p.id = h.person_id
  where h.verification_code = p_verification_code and h.public_verification_consented and h.deleted_at is null
    and (h.expires_on is null or h.expires_on >= current_date);
$$;
comment on function api_public.verify_certification(text) is 'Named token RPC (invariant 7 and 21): returns only the fields a public verification page renders for a current certificate whose holder consented; nothing otherwise.';
revoke all on function api_public.verify_certification(text) from public;
grant execute on function api_public.verify_certification(text) to anon, authenticated, service_role;

call private.install_policies('app.credentials',
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.credential.read')))
    or holder_person_id = (select private.current_person_id())$$,
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.credential.issue')))$$,
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.credential.revoke')))$$);
call private.install_policies('app.access_grid',
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.credential.read')))$$,
  $$credential_category_id in (select c.id from app.credential_categories c where c.project_id in (select private.project_ids_with('credentials.access_grid.write')))$$);
call private.install_policies('app.access_scans',
  $$credential_id in (select cr.id from app.credentials cr join app.credential_categories c on c.id = cr.credential_category_id
     where c.project_id in (select private.project_ids_with('credentials.scan_log.read')))$$,
  $$credential_id in (select cr.id from app.credentials cr join app.credential_categories c on c.id = cr.credential_category_id
     where c.project_id in (select private.project_ids_with('credentials.scan.write')))$$);
revoke update on app.access_scans from authenticated;
drop policy access_scans_update on app.access_scans;
call private.install_policies('app.certifications',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('people.certification.verify'))$$);
call private.install_policies('app.certification_holders',
  $$org_id in (select private.orgs_with_capability('people.certification.read')) or person_id = (select private.current_person_id())$$,
  $$org_id in (select private.orgs_with_capability('people.certification.verify'))$$,
  $$org_id in (select private.orgs_with_capability('people.certification.verify')) or person_id = (select private.current_person_id())$$);
