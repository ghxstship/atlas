-- Postal addresses by country (A139, Section 15, trace S15-13). The Atlas and Gateway address forms check the
-- fields a country requires and its postal code with packages/i18n/src/formats/address.ts (Google's address
-- metadata); the database checks the postal code with the same patterns wherever the row's country is known:
--   * private.postal_code_pattern holds Google's `zip` pattern for each country address.ts lists (a test in
--     packages/i18n keeps the two lists the same); private.postal_code_fits matches a code against it, and gives a
--     country without a pattern 1 to 12 characters;
--   * private.enforce_postal_code refuses (postal_code_invalid) a new row, or a row whose country or postal code
--     changes, when the code does not fit its country. Rows stored before this migration stay as they are, and
--     private.contact_format_exceptions (2321) lists the ones that do not fit;
--   * venues take their country from their jurisdiction; org legal entities gain a registered address, and vendors a
--     mailing address with its country, both checked the same way. Tax forms keep the ZIP check of 1124, since a
--     W-9 address is a US address.

-- Postal code patterns -------------------------------------------------------------------------------------------

create or replace function private.postal_code_pattern(p_country text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case upper(btrim(p_country))
    when 'AT' then '\d{4}'
    when 'AU' then '\d{4}'
    when 'BE' then '\d{4}'
    when 'BR' then '\d{5}-?\d{3}'
    when 'CA' then '[ABCEGHJKLMNPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d'
    when 'CH' then '\d{4}'
    when 'CN' then '\d{6}'
    when 'DE' then '\d{5}'
    when 'DK' then '\d{4}'
    when 'ES' then '\d{5}'
    when 'FI' then '\d{5}'
    when 'FR' then '\d{2} ?\d{3}'
    when 'GB' then 'GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2}|BFPO ?\d{1,4}'
    when 'IE' then '[\dA-Z]{3} ?[\dA-Z]{4}'
    when 'IN' then '\d{6}'
    when 'IT' then '\d{5}'
    when 'JP' then '\d{3}-?\d{4}'
    when 'KR' then '\d{5}'
    when 'MX' then '\d{5}'
    when 'NL' then '\d{4} ?[A-Z]{2}'
    when 'NO' then '\d{4}'
    when 'NZ' then '\d{4}'
    when 'PL' then '\d{2}-\d{3}'
    when 'PT' then '\d{4}-\d{3}'
    when 'SE' then '\d{3} ?\d{2}'
    when 'SG' then '\d{6}'
    when 'US' then '(\d{5})(?:[ \-](\d{4}))?'
    when 'ZA' then '\d{4}'
  end;
$$;

comment on function private.postal_code_pattern(text) is 'Google address metadata postal code pattern (`zip`) for an ISO 3166-1 alpha-2 country, the same list as packages/i18n/src/formats/address.ts; NULL for a country without one.';
revoke all on function private.postal_code_pattern(text) from public, anon;
grant execute on function private.postal_code_pattern(text) to authenticated, service_role;

create or replace function private.postal_code_fits(p_country text, p_postal_code text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_postal_code is null then true
    when private.postal_code_pattern(p_country) is null then char_length(btrim(p_postal_code)) between 1 and 12
    else btrim(p_postal_code) ~* ('^(?:' || private.postal_code_pattern(p_country) || ')$')
  end;
$$;

comment on function private.postal_code_fits(text, text) is 'True when the postal code fits its country''s pattern, matched whole and ignoring case, or has 1 to 12 characters in a country without a pattern. A missing code fits: whether one is required is the form''s rule.';
revoke all on function private.postal_code_fits(text, text) from public, anon;
grant execute on function private.postal_code_fits(text, text) to authenticated, service_role;

-- Trigger arguments: the column holding the country (its first two letters are read, so a jurisdiction such as
-- US-FL-MIAMI-DADE gives US) and the column holding the postal code.
create or replace function private.enforce_postal_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_country text := left(upper(v_new ->> tg_argv[0]), 2);
  v_code text := v_new ->> tg_argv[1];
begin
  if v_code is null or v_country is null or v_country !~ '^[A-Z]{2}$' then
    return new;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(old) -> tg_argv[0]) is not distinct from (v_new -> tg_argv[0])
     and (to_jsonb(old) -> tg_argv[1]) is not distinct from (v_new -> tg_argv[1]) then
    return new;
  end if;
  if not private.postal_code_fits(v_country, v_code) then
    perform private.refuse('postal_code_invalid', format('%s is not a postal code in %s. Check it against the address.', btrim(v_code), v_country));
  end if;
  return new;
end;
$$;

comment on function private.enforce_postal_code() is 'Refuses a new row, or a row whose country or postal code changes, when the postal code does not fit the country (private.postal_code_fits). Arguments: the country column (its first two letters) and the postal code column. Rows that do not change are never refused.';
revoke all on function private.enforce_postal_code() from public, anon, authenticated;

-- Venues ---------------------------------------------------------------------------------------------------------

create trigger t45_venue_postal_code before insert or update of jurisdiction_id, postal_code on app.venues
  for each row execute function private.enforce_postal_code('jurisdiction_id', 'postal_code');

comment on column app.venues.postal_code is 'Postal code, in the format of the venue''s country (the first two letters of its jurisdiction).';

-- Org legal entities -----------------------------------------------------------------------------------------------

alter table app.org_legal_entities
  add column street_address text,
  add column locality text,
  add column administrative_area text,
  add column postal_code text,
  add constraint org_legal_entities_street_length check (street_address is null or char_length(btrim(street_address)) between 1 and 200),
  add constraint org_legal_entities_locality_length check (locality is null or char_length(btrim(locality)) between 1 and 100),
  add constraint org_legal_entities_area_length check (administrative_area is null or char_length(btrim(administrative_area)) between 1 and 100),
  add constraint org_legal_entities_postal_length check (postal_code is null or char_length(btrim(postal_code)) between 1 and 12);

comment on column app.org_legal_entities.street_address is 'Street line of the registered address.';
comment on column app.org_legal_entities.locality is 'City or locality of the registered address.';
comment on column app.org_legal_entities.administrative_area is 'State, province or prefecture of the registered address, as its code or name.';
comment on column app.org_legal_entities.postal_code is 'Postal code of the registered address, in the format of country_code.';

grant select (street_address, locality, administrative_area, postal_code) on app.org_legal_entities to authenticated;
grant insert (street_address, locality, administrative_area, postal_code) on app.org_legal_entities to authenticated;
grant update (street_address, locality, administrative_area, postal_code) on app.org_legal_entities to authenticated;

create trigger t45_legal_entity_postal_code before insert or update of country_code, postal_code on app.org_legal_entities
  for each row execute function private.enforce_postal_code('country_code', 'postal_code');

-- The masked view (1200) gains the address, appended so its other columns keep their places and grants.
create or replace view app.org_legal_entities_masked as
select e.id, e.org_id, e.legal_name, e.country_code,
  private.org_tax_identifier_plaintext(e.org_id, e.tax_identifier) as tax_identifier,
  e.tax_identifier_last4,
  (e.tax_identifier is not null and not private.has_capability(e.org_id, 'data.restricted.read.tax')) as is_masked,
  e.fiscal_year_start_month, e.base_currency, e.is_primary,
  e.created_at, e.created_by, e.updated_at, e.updated_by,
  e.street_address, e.locality, e.administrative_area, e.postal_code
from app.org_legal_entities e
where e.deleted_at is null
  and e.org_id in (select private.orgs_with_capability('org.settings.read'));

comment on column app.org_legal_entities_masked.street_address is 'Street line of the registered address.';
comment on column app.org_legal_entities_masked.locality is 'City or locality of the registered address.';
comment on column app.org_legal_entities_masked.administrative_area is 'State, province or prefecture of the registered address.';
comment on column app.org_legal_entities_masked.postal_code is 'Postal code of the registered address.';

-- Vendors --------------------------------------------------------------------------------------------------------

alter table app.vendors
  add column country_code char(2),
  add column street_address text,
  add column locality text,
  add column administrative_area text,
  add column postal_code text,
  add constraint vendors_country_code_format check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  add constraint vendors_street_length check (street_address is null or char_length(btrim(street_address)) between 1 and 200),
  add constraint vendors_locality_length check (locality is null or char_length(btrim(locality)) between 1 and 100),
  add constraint vendors_area_length check (administrative_area is null or char_length(btrim(administrative_area)) between 1 and 100),
  add constraint vendors_postal_length check (postal_code is null or char_length(btrim(postal_code)) between 1 and 12),
  add constraint vendors_address_country check (country_code is not null or num_nonnulls(street_address, locality, administrative_area, postal_code) = 0);

comment on column app.vendors.country_code is 'ISO 3166-1 alpha-2 country of the vendor''s mailing address; set whenever any address field is.';
comment on column app.vendors.street_address is 'Street line of the vendor''s mailing address.';
comment on column app.vendors.locality is 'City or locality of the vendor''s mailing address.';
comment on column app.vendors.administrative_area is 'State, province or prefecture of the vendor''s mailing address, as its code or name.';
comment on column app.vendors.postal_code is 'Postal code of the vendor''s mailing address, in the format of country_code.';

create trigger t45_vendor_postal_code before insert or update of country_code, postal_code on app.vendors
  for each row execute function private.enforce_postal_code('country_code', 'postal_code');
