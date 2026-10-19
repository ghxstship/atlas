-- 1200_org_legal_entities.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Settings, Legal Entities and Fiscal (Section 4.5.6 item 3) lists
-- legal entities, tax identifiers, fiscal year start and base currency, and Section 7.3 names `org_legal_entities` under
-- tenancy. A50 retired orgLegalEntities because no table backed it. app.org_legal_entities holds each legal entity an org
-- trades as:
--   * read with org.settings.read, written with org.legal_entities.write (the capabilities the v1 contract names)
--   * one entity per org is the primary one, printed on generated documents; the first entity becomes primary, marking
--     another primary moves the mark, and the primary cannot be deleted while other live entities remain
--   * the tax identifier is Restricted (Section 8.3) and field-encrypted with pgcrypto under its own Vault key (Section 9):
--     signed-in callers can neither select nor write the ciphertext; it is written only through
--     app.set_org_legal_entity_tax_identifier and read decrypted only through app.org_legal_entities_masked by holders of
--     data.restricted.read.tax. Its last four characters are shown to every reader.
--   * the org-wide settings org.fiscal_year_start_month and org.base_currency stay the org's defaults (a new project's
--     currency, 0950); an entity carries its own fiscal year and base currency, since an org may trade through entities
--     in several countries
--   * a legal name appears once per org among live entities; delete is soft

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'xos_org_tax_identifier_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_org_tax_identifier_key',
      'Symmetric key that encrypts org legal entity tax identifiers on app.org_legal_entities (Sections 8.3 and 9).');
  end if;
end $$;

create or replace function private.org_tax_identifier_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_org_tax_identifier_key';
$$;

comment on function private.org_tax_identifier_key() is 'The Vault key that encrypts org legal entity tax identifiers. Never granted to signed-in callers.';
revoke all on function private.org_tax_identifier_key() from public, anon, authenticated;

create table app.org_legal_entities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  legal_name text not null,
  country_code char(2) not null,
  tax_identifier bytea,
  tax_identifier_last4 text,
  fiscal_year_start_month smallint not null default 1,
  base_currency char(3) not null references private.currencies (currency_code),
  is_primary boolean not null default false,
  deleted_at timestamptz,
  constraint org_legal_entities_legal_name_length check (char_length(btrim(legal_name)) between 1 and 200),
  constraint org_legal_entities_country_code_format check (country_code ~ '^[A-Z]{2}$'),
  constraint org_legal_entities_fiscal_month check (fiscal_year_start_month between 1 and 12),
  constraint org_legal_entities_last4_format check (tax_identifier_last4 is null or tax_identifier_last4 ~ '^[0-9A-Z]{1,4}$'),
  constraint org_legal_entities_tax_pair check ((tax_identifier is null) = (tax_identifier_last4 is null))
);

create index org_legal_entities_base_currency_idx on app.org_legal_entities (base_currency);
create unique index org_legal_entities_org_name_key on app.org_legal_entities (org_id, lower(btrim(legal_name))) where deleted_at is null;
create unique index org_legal_entities_org_primary_key on app.org_legal_entities (org_id) where is_primary and deleted_at is null;

call private.install_domain_table('app.org_legal_entities');
call private.describe('app.org_legal_entities', 'Legal entities an org trades as, with their tax identifier, fiscal year start and base currency (Section 4.5.6 item 3, Section 7.3). One live entity per org is primary and is printed on generated documents. The tax identifier is Restricted and encrypted: read it through app.org_legal_entities_masked.', array[
  'legal_name', 'Registered legal name, for example Northwind Live LLC. Unique per org among live entities.',
  'country_code', 'ISO 3166-1 alpha-2 country of registration.',
  'tax_identifier', 'Tax identifier (EIN, VAT or GST number) encrypted with pgp_sym_encrypt under the Vault key xos_org_tax_identifier_key. Restricted (data.restricted.read.tax): never selectable or writable by signed-in callers; written through app.set_org_legal_entity_tax_identifier and read through app.org_legal_entities_masked.',
  'tax_identifier_last4', 'Last four characters of the tax identifier, shown to every reader; NULL when none is recorded.',
  'fiscal_year_start_month', 'Month the entity''s fiscal year starts, 1 for January through 12 for December.',
  'base_currency', 'ISO 4217 currency the entity keeps its books in.',
  'is_primary', 'True for the org''s primary entity, printed on generated documents. Exactly one live entity per org is primary once any exists.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.org_legal_entities', 'tax_identifier', 'Restricted', 'data.restricted.read.tax');

call private.install_policies('app.org_legal_entities',
  $$org_id in (select private.orgs_with_capability('org.settings.read'))$$,
  $$org_id in (select private.orgs_with_capability('org.legal_entities.write'))$$);

-- Column grants: the ciphertext and its last four are written only by the RPC; the Restricted column is never selectable.
revoke select, insert, update on app.org_legal_entities from authenticated;
grant select (id, org_id, legal_name, country_code, tax_identifier_last4, fiscal_year_start_month, base_currency, is_primary,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.org_legal_entities to authenticated;
grant insert (org_id, legal_name, country_code, fiscal_year_start_month, base_currency, is_primary) on app.org_legal_entities to authenticated;
grant update (legal_name, country_code, fiscal_year_start_month, base_currency, is_primary, deleted_at) on app.org_legal_entities to authenticated;

call private.install_default_retention('app.org_legal_entities');
call private.install_audit_trail('app.org_legal_entities');

-- Primary entity and tax identifier guard ---------------------------------------------------------------------------------

create or replace function private.guard_org_legal_entity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The primary mark moving off another row, from the branch below.
  if private.in_trusted_operation('legal_entity_primary_move') then
    return new;
  end if;

  if (tg_op = 'INSERT' and (new.tax_identifier is not null or new.tax_identifier_last4 is not null))
     or (tg_op = 'UPDATE' and (new.tax_identifier is distinct from old.tax_identifier
                               or new.tax_identifier_last4 is distinct from old.tax_identifier_last4)) then
    if not private.in_trusted_operation('org_tax_identifier_write') then
      perform private.refuse('tax_identifier_rpc_only', 'A tax identifier is written only through app.set_org_legal_entity_tax_identifier, which encrypts it.');
    end if;
  end if;

  if tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null then
    perform private.refuse('legal_entity_deleted', 'A deleted legal entity cannot be restored; add it again.');
  end if;

  -- Deleting the primary entity while others remain would leave documents without an issuer.
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    if old.is_primary and exists (
      select 1 from app.org_legal_entities e
      where e.org_id = new.org_id and e.id <> new.id and e.deleted_at is null) then
      perform private.refuse('legal_entity_primary', 'Mark another legal entity primary before deleting the primary one.');
    end if;
    new.is_primary := false;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.is_primary and not new.is_primary and new.deleted_at is null then
    perform private.refuse('legal_entity_primary', 'Mark another legal entity primary instead; the org keeps one primary entity.');
  end if;

  -- The first live entity is primary; marking another primary moves the mark.
  if new.deleted_at is null then
    if not exists (select 1 from app.org_legal_entities e
                   where e.org_id = new.org_id and e.is_primary and e.deleted_at is null and e.id <> new.id) then
      new.is_primary := true;
    elsif new.is_primary and (tg_op = 'INSERT' or not old.is_primary) then
      perform private.begin_trusted_operation('legal_entity_primary_move');
      update app.org_legal_entities e set is_primary = false
      where e.org_id = new.org_id and e.is_primary and e.deleted_at is null and e.id <> new.id;
      perform private.end_trusted_operation('legal_entity_primary_move');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_org_legal_entity() is 'Org legal entities: the tax identifier changes only inside the encrypting RPC; the first live entity is primary, marking another primary moves the mark, the primary is never unmarked directly and cannot be deleted while other live entities remain; a deleted entity is not restored.';
revoke all on function private.guard_org_legal_entity() from public, anon, authenticated;

create trigger t40_guard_org_legal_entity before insert or update on app.org_legal_entities
  for each row execute function private.guard_org_legal_entity();

-- Tax identifier ---------------------------------------------------------------------------------------------------------

create or replace function app.set_org_legal_entity_tax_identifier(p_legal_entity_id uuid, p_tax_identifier text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entity app.org_legal_entities;
  v_clean text := upper(regexp_replace(coalesce(p_tax_identifier, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  perform private.require_person();
  select * into v_entity from app.org_legal_entities e where e.id = p_legal_entity_id and e.deleted_at is null;
  if v_entity.id is null or not private.has_capability(v_entity.org_id, 'org.legal_entities.write') then
    raise exception using errcode = '42501', message = 'org.legal_entities.write is required';
  end if;
  if p_tax_identifier is not null and (char_length(v_clean) < 4 or char_length(v_clean) > 30) then
    perform private.refuse('tax_identifier_format', 'A tax identifier has 4 to 30 letters and digits.');
  end if;
  perform private.begin_trusted_operation('org_tax_identifier_write');
  update app.org_legal_entities e set
    tax_identifier = case when p_tax_identifier is null then null
                          else extensions.pgp_sym_encrypt(v_clean, private.org_tax_identifier_key()) end,
    tax_identifier_last4 = case when p_tax_identifier is null then null else right(v_clean, 4) end
  where e.id = v_entity.id;
  perform private.end_trusted_operation('org_tax_identifier_write');
  perform private.write_audit_event(v_entity.org_id, 'org_legal_entities.tax_identifier_set', 'app.org_legal_entities', v_entity.id,
    jsonb_build_object('cleared', p_tax_identifier is null));
end;
$$;

comment on function app.set_org_legal_entity_tax_identifier(uuid, text) is 'Sets or clears (NULL) a legal entity''s tax identifier: keeps letters and digits, encrypts them under the Vault key and stores the last four. Requires org.legal_entities.write in the entity''s org. The audit event records that it changed, never the value.';
revoke all on function app.set_org_legal_entity_tax_identifier(uuid, text) from public, anon;
grant execute on function app.set_org_legal_entity_tax_identifier(uuid, text) to authenticated, service_role;

create or replace function private.org_tax_identifier_plaintext(p_org_id uuid, p_ciphertext bytea)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_ciphertext is not null and private.has_capability(p_org_id, 'data.restricted.read.tax')
    then extensions.pgp_sym_decrypt(p_ciphertext, private.org_tax_identifier_key()) end;
$$;

comment on function private.org_tax_identifier_plaintext(uuid, bytea) is 'Decrypts a legal entity tax identifier for a holder of data.restricted.read.tax in its org, else NULL. Takes column values and never re-reads the table; signed-in callers cannot select the ciphertext, so they reach it only through app.org_legal_entities_masked.';
revoke all on function private.org_tax_identifier_plaintext(uuid, bytea) from public, anon;
grant execute on function private.org_tax_identifier_plaintext(uuid, bytea) to authenticated, service_role;

create view app.org_legal_entities_masked as
select e.id, e.org_id, e.legal_name, e.country_code,
  private.org_tax_identifier_plaintext(e.org_id, e.tax_identifier) as tax_identifier,
  e.tax_identifier_last4,
  (e.tax_identifier is not null and not private.has_capability(e.org_id, 'data.restricted.read.tax')) as is_masked,
  e.fiscal_year_start_month, e.base_currency, e.is_primary,
  e.created_at, e.created_by, e.updated_at, e.updated_by
from app.org_legal_entities e
where e.deleted_at is null
  and e.org_id in (select private.orgs_with_capability('org.settings.read'));

call private.describe('app.org_legal_entities_masked', 'Live org legal entities with the Restricted tax identifier decrypted for holders of data.restricted.read.tax and masked (NULL with is_masked true) for everyone else (Section 8.3). Rows are limited to orgs where the caller reads settings.', array[
  'id', 'Legal entity.',
  'org_id', 'Owning org.',
  'legal_name', 'Registered legal name.',
  'country_code', 'Country of registration.',
  'tax_identifier', 'Tax identifier in plain text for holders of data.restricted.read.tax; NULL when masked or not recorded.',
  'tax_identifier_last4', 'Last four characters of the tax identifier.',
  'is_masked', 'True when a tax identifier is recorded but the caller may not read it.',
  'fiscal_year_start_month', 'Month the fiscal year starts.',
  'base_currency', 'Currency the entity keeps its books in.',
  'is_primary', 'True for the org''s primary entity.',
  'created_at', 'When the entity was added.',
  'created_by', 'Person who added it.',
  'updated_at', 'When it last changed.',
  'updated_by', 'Person who last changed it.'
]);
revoke all on app.org_legal_entities_masked from public, anon;
grant select on app.org_legal_entities_masked to authenticated, service_role;
