-- Work phones in E.164 (A139, Section 15, trace S15-14). Atlas, Gateway and Compass read a typed work phone
-- (workforce.work_phone, 1010) with toE164 and save only the E.164 form; the database now holds the same line:
--   * private.e164_from_text reads the stored numbers whose form is unambiguous: an international number written
--     with + or 00 and any spacing, and a ten-digit North American number, with or without its leading 1, read as
--     a US number since XOS ships in en-US and es-US. private.normalize_work_phones rewrites those values once;
--   * private.enforce_work_phone_e164 refuses (work_phone_e164) a new or changed work phone that is not E.164. A value
--     that could not be read stays as the person typed it until they change it, and is listed below;
--   * private.contact_format_exceptions lists the stored values these checks would refuse: work phones that are not
--     E.164 and postal codes that do not fit their country (2320). Platform operators read it with the service role.

-- Reading stored numbers -----------------------------------------------------------------------------------------

create or replace function private.e164_from_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with compact as (
    select regexp_replace(btrim(p_text), '[[:space:]()./-]', '', 'g') as digits
    where btrim(p_text) ~ '^\+?[0-9[:space:]()./-]+$'
  )
  select case
    when digits ~ '^\+[1-9][0-9]{7,14}$' then digits
    when digits ~ '^00[1-9][0-9]{7,14}$' then '+' || substr(digits, 3)
    when digits ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then '+1' || digits
    when digits ~ '^1[2-9][0-9]{2}[2-9][0-9]{6}$' then '+' || digits
  end
  from compact;
$$;

comment on function private.e164_from_text(text) is 'The E.164 form of a stored phone number whose form is unambiguous: + or 00 and 8 to 15 digits with any spacing, or a North American number of ten digits (or eleven with its leading 1). NULL for anything else. Typed numbers go through toE164 in the apps, which knows every country''s numbering plan.';
revoke all on function private.e164_from_text(text) from public, anon;
grant execute on function private.e164_from_text(text) to authenticated, service_role;

create or replace function private.normalize_work_phones()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- A per-org value of someone who has left that org is skipped: the 0850 guard refuses any write to it.
  update app.personal_setting_values v
  set value_text = private.e164_from_text(v.value_text)
  where v.setting_key = 'workforce.work_phone'
    and v.deleted_at is null
    and v.value_text is not null
    and private.e164_from_text(v.value_text) is not null
    and private.e164_from_text(v.value_text) <> v.value_text
    and (v.org_id is null or exists (
      select 1 from app.memberships m
      where m.org_id = v.org_id and m.person_id = v.person_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function private.normalize_work_phones() is 'Rewrites stored work phones (workforce.work_phone) that private.e164_from_text can read into E.164, and returns how many changed. Run once by migration 2321; values it cannot read are listed by private.contact_format_exceptions.';
revoke all on function private.normalize_work_phones() from public, anon, authenticated;
grant execute on function private.normalize_work_phones() to service_role;

select private.normalize_work_phones();

-- The check ------------------------------------------------------------------------------------------------------

create or replace function private.enforce_work_phone_e164()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null or new.value_text is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value_text is not distinct from old.value_text then
    return new;
  end if;
  if new.value_text !~ '^\+[1-9][0-9]{7,14}$' then
    perform private.refuse('work_phone_e164', 'Give the work phone with its country code, for example +13055550199.');
  end if;
  return new;
end;
$$;

comment on function private.enforce_work_phone_e164() is 'Refuses a new or changed work phone (workforce.work_phone) that is not E.164: + and 8 to 15 digits, the first not 0. A stored value that does not change is never refused.';
revoke all on function private.enforce_work_phone_e164() from public, anon, authenticated;

create trigger t41_work_phone_e164 before insert or update of value_text, deleted_at on app.personal_setting_values
  for each row when (new.setting_key = 'workforce.work_phone')
  execute function private.enforce_work_phone_e164();

-- Stored values the checks would refuse ----------------------------------------------------------------------------

create view private.contact_format_exceptions as
select 'app.venues'::text as table_name, v.id as row_id, v.org_id, null::uuid as person_id,
  'postal_code'::text as column_name, v.postal_code as stored_value, left(v.jurisdiction_id, 2) as country_code
from app.venues v
where v.deleted_at is null and not private.postal_code_fits(left(v.jurisdiction_id, 2), v.postal_code)
union all
select 'app.org_legal_entities', e.id, e.org_id, null, 'postal_code', e.postal_code, e.country_code
from app.org_legal_entities e
where e.deleted_at is null and not private.postal_code_fits(e.country_code, e.postal_code)
union all
select 'app.vendors', d.id, d.org_id, null, 'postal_code', d.postal_code, d.country_code
from app.vendors d
where d.deleted_at is null and d.country_code is not null and not private.postal_code_fits(d.country_code, d.postal_code)
union all
select 'app.personal_setting_values', p.id, p.org_id, p.person_id, 'workforce.work_phone', p.value_text, null
from app.personal_setting_values p
where p.setting_key = 'workforce.work_phone' and p.deleted_at is null and p.value_text is not null
  and p.value_text !~ '^\+[1-9][0-9]{7,14}$';

comment on view private.contact_format_exceptions is 'Stored values the A139 checks would refuse today: postal codes that do not fit their country (venues, org legal entities, vendors) and work phones that are not E.164. They were saved before the checks and stay until someone changes them; the org or person fixes each from the record or Work Details. Service role only.';
comment on column private.contact_format_exceptions.table_name is 'Table holding the value.';
comment on column private.contact_format_exceptions.row_id is 'Row holding the value.';
comment on column private.contact_format_exceptions.org_id is 'Org of the row; for a work phone, the org the value applies to, NULL for every org.';
comment on column private.contact_format_exceptions.person_id is 'Person whose work phone it is; NULL for an address.';
comment on column private.contact_format_exceptions.column_name is 'Column, or setting key, of the value.';
comment on column private.contact_format_exceptions.stored_value is 'The value as stored.';
comment on column private.contact_format_exceptions.country_code is 'Country the postal code was checked against; NULL for a work phone.';

revoke all on private.contact_format_exceptions from public, anon, authenticated;
revoke select on private.contact_format_exceptions from xos_backup;
grant select on private.contact_format_exceptions to service_role;

do $$
declare
  v_counts text;
begin
  select string_agg(format('%s %s', n, table_name), ', ' order by table_name) into v_counts
  from (select table_name, count(*) as n from private.contact_format_exceptions group by table_name) c;
  if v_counts is not null then
    raise notice 'Stored values that do not fit the A139 checks (private.contact_format_exceptions): %', v_counts;
  end if;
end;
$$;
