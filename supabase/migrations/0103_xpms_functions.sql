-- 0103_xpms_functions.sql
-- A01 Canon. Canon resolution functions (Section 7.2). Every function pins
-- search_path to '' and schema-qualifies every reference (ADR 0002). None is
-- SECURITY DEFINER: callers read canon through their own select privilege.

-- Refusal semantics (Section 3.7) -------------------------------------------------

create or replace function xpms.assert_or_refuse(claim text, domain text, is_critical boolean)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  claim_rank integer;
begin
  if domain is null or not exists (select 1 from xpms.dim_assertion_word w where w.domain = assert_or_refuse.domain) then
    return 'REFUSE';
  end if;
  if claim is null then
    return case when is_critical then 'REFUSE' else 'NO_ANSWER' end;
  end if;
  select w.rank into claim_rank
    from xpms.dim_assertion_word w
   where w.domain = assert_or_refuse.domain
     and w.word = upper(btrim(claim));
  if not found then
    return 'REFUSE';
  end if;
  if claim_rank = 0 then
    return case when is_critical then 'REFUSE' else 'NO_ANSWER' end;
  end if;
  if claim_rank = 1 and is_critical then
    return 'UNRATIFIED';
  end if;
  return upper(btrim(claim));
end;
$$;

comment on function xpms.assert_or_refuse(text, text, boolean) is
  'Returns the claim (an assertion word of the domain) or a refusal. An absent claim, or a rank 0 word (EXPIRED, UNKNOWN), is NO_ANSWER, or REFUSE when critical. A critical requirement resting on a rank 1 claim nobody attested (MODELED, INFERRED) is UNRATIFIED. An unknown domain or word is REFUSE. Never a permissive default.';

-- Staleness policy (Section 3.8, Bible tab 14) -------------------------------------

create or replace function xpms.band_effective_confidence(
  confidence text,
  valid_from date,
  valid_to date,
  as_of date default current_date
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  word_rank integer;
  age_months integer;
  policy_action text;
  floor_rank integer;
  result text;
begin
  if confidence is null or valid_from is null or as_of is null then
    return 'NO_ANSWER';
  end if;
  select w.rank into word_rank
    from xpms.dim_assertion_word w
   where w.domain = 'economics' and w.word = confidence;
  if not found then
    return 'REFUSE';
  end if;
  if word_rank = 0 or (valid_to is not null and as_of > valid_to) then
    return (select w.word from xpms.dim_assertion_word w where w.domain = 'economics' and w.rank = 0);
  end if;
  if as_of < valid_from then
    return 'NO_ANSWER';
  end if;
  age_months := (extract(year from age(as_of, valid_from)) * 12 + extract(month from age(as_of, valid_from)))::integer;
  select p.action into policy_action
    from xpms.dim_staleness_policy p
   where p.age_months_gte <= age_months
   order by p.age_months_gte desc
   limit 1;
  floor_rank := 1;
  result := case policy_action
    when 'hold' then confidence
    when 'degrade_one_step' then (
      select w.word from xpms.dim_assertion_word w
       where w.domain = 'economics' and w.rank = greatest(word_rank - 1, least(word_rank, floor_rank)))
    when 'degrade_to_modeled' then (
      select w.word from xpms.dim_assertion_word w
       where w.domain = 'economics' and w.rank = least(word_rank, floor_rank))
    when 'expire' then (
      select w.word from xpms.dim_assertion_word w where w.domain = 'economics' and w.rank = 0)
    else null
  end;
  return coalesce(result, 'NO_ANSWER');
end;
$$;

comment on function xpms.band_effective_confidence(text, date, date, date) is
  'Effective economics confidence of a price band as of a date, computed at read time from xpms.dim_staleness_policy: hold under 12 months, one step down from 12 (never below MODELED), MODELED from 24, EXPIRED from 36 or after valid_to. A band with no stated confidence or source date is NO_ANSWER.';

-- Provenance ranks (Section 3.8, Bible tab 19) --------------------------------------

create or replace function xpms.may_write_field(element_id text, field text, provenance text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  writer_rank integer;
  writer_may text;
  current_value text;
  owner_rank integer;
begin
  select p.rank, p.may_overwrite into writer_rank, writer_may
    from xpms.dim_provenance p
   where p.provenance = may_write_field.provenance;
  if not found then
    return false;
  end if;
  if field is null or field in ('element_id') or not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'xpms.elements'::pg_catalog.regclass
       and a.attname = field and a.attnum > 0 and not a.attisdropped
  ) then
    return false;
  end if;
  select pg_catalog.to_jsonb(e) ->> field into current_value
    from xpms.elements e
   where e.element_id = may_write_field.element_id;
  if not found then
    return false;
  end if;
  if current_value is null then
    return true;
  end if;
  select p.rank into owner_rank
    from xpms.field_provenance fp
    join xpms.dim_provenance p on p.provenance = fp.provenance
   where fp.element_id = may_write_field.element_id
     and fp.field_name = field;
  if not found then
    -- A populated field with no recorded writer is an absent claim: refuse.
    return false;
  end if;
  return writer_rank >= owner_rank and writer_may = 'any';
end;
$$;

comment on function xpms.may_write_field(text, text, text) is
  'True when a writer of the given provenance may write the element field: any known provenance may populate an empty field; a populated field may be overwritten only by a provenance whose canon rule is "any" and whose rank is at least the recorded writer''s. Canon element fields are canon-locked, so an operator may not overwrite them. Unknown elements, fields or provenances refuse.';

-- URID grammar (Section 3.3) ----------------------------------------------------------

create or replace function xpms.urid_segment(urid text, level text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when urid is null or urid !~ '^[0-9]{4}(\.[0-9]{2}){0,2}$' then null
    when level = 'department' then left(urid, 4)
    when level = 'discipline' and length(urid) >= 7 then left(urid, 7)
    when level = 'category' and length(urid) = 10 then urid
    else null
  end;
$$;

comment on function xpms.urid_segment(text, text) is
  'The department (DDDD), discipline (DDDD.DD) or category (DDDD.DD.DD) segment of a URID. NULL when the URID is malformed or shorter than the level; there is no fourth segment.';

create or replace function xpms.is_extension_urid(urid text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when urid is null or urid !~ '^[0-9]{4}(\.[0-9]{2}){1,2}$' then null
    else substr(urid, 6, 2)::integer >= 50
      or (length(urid) = 10 and substr(urid, 9, 2)::integer >= 50)
  end;
$$;

comment on function xpms.is_extension_urid(text) is
  'True when the discipline or category segment is in the adopter extension range .50 to .99; NULL for a malformed URID.';

-- Catalog resolution (Sections 3.9 and 7.2) --------------------------------------------

create or replace function xpms.resolve_element(query text)
returns table (element_id text, item text, urid text, match text)
language sql
stable
set search_path = ''
as $$
  with q as (select btrim(query) as v)
  select e.element_id::text, e.item::text, e.urid::text, m.match
    from xpms.elements e, q,
    lateral (
      select case
        when e.element_id = q.v then 'element_id'
        when e.external_ref = q.v then 'external_ref'
        when lower(e.item) = lower(q.v) then 'item'
        when e.common_name is not null and lower(e.common_name) = lower(q.v) then 'common_name'
      end as match
    ) m
   where q.v <> '' and m.match is not null
   order by case m.match when 'element_id' then 1 when 'external_ref' then 2 when 'item' then 3 else 4 end,
            e.element_id;
$$;

comment on function xpms.resolve_element(text) is
  'Elements matching a query by item ID, external reference, item name or common name (exact, case-insensitive for names), best match first. No row means no answer; it never guesses a near match.';

create or replace function xpms.resolve_gtin(code text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when code is null or code !~ '^[0-9]{8}$|^[0-9]{12,14}$' then 'REFUSE'
    else coalesce(
      (select g.element_id::text from xpms.element_gtins g where g.gtin = lpad(code, 14, '0')),
      'NO_ANSWER'
    )
  end;
$$;

comment on function xpms.resolve_gtin(text) is
  'The element a GTIN (8, 12, 13 or 14 digits, padded to GTIN-14) is bound to, NO_ANSWER when no confirmed binding exists, REFUSE for a malformed code. Many GTINs may map to one element.';

-- URNs (Section 3.1) ---------------------------------------------------------------------

create or replace function xpms.urn(kind text, key text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if kind is null or key is null or btrim(key) = '' then
    return null;
  end if;
  if not exists (select 1 from xpms.dim_urn_namespace n where n.kind = urn.kind) then
    raise exception 'Unknown URN kind %', kind using errcode = 'invalid_parameter_value';
  end if;
  return 'urn:xpms:' || kind || ':' || key;
end;
$$;

comment on function xpms.urn(text, text) is
  'Builds urn:xpms:{kind}:{key} for a registered kind (xpms.dim_urn_namespace). Unknown kinds raise.';

create or replace function xpms.urn_parse(urn text)
returns table (kind text, key text)
language sql
immutable
set search_path = ''
as $$
  select m[1], m[2]
    from regexp_match(urn, '^urn:xpms:([a-z][a-z_]*):(.+)$') as m
   where m is not null;
$$;

comment on function xpms.urn_parse(text) is
  'Splits urn:xpms:{kind}:{key} into its kind and key; no row for a string outside the namespace.';

create or replace function xpms.urn_resolve(urn text)
returns table (kind text, key text, resolved_key text, label text, is_superseded boolean)
language plpgsql
stable
set search_path = ''
as $$
declare
  parsed record;
  ns record;
  target text;
  successor text;
  hops integer := 0;
  found_label text;
begin
  select p.kind, p.key into parsed from xpms.urn_parse(urn) p;
  if parsed.kind is null then
    return;
  end if;
  select n.table_name, n.key_column, n.label_column into ns
    from xpms.dim_urn_namespace n where n.kind = parsed.kind;
  if not found then
    return;
  end if;
  target := parsed.key;
  loop
    select s.successor_code into successor
      from xpms.supersession s
     where s.domain = parsed.kind and s.code = target;
    exit when not found;
    target := successor;
    hops := hops + 1;
    exit when hops > 1000;
  end loop;
  execute format('select (%I)::text from xpms.%I where (%I)::text = $1', ns.label_column, ns.table_name, ns.key_column)
    into found_label
    using target;
  if found_label is null then
    return;
  end if;
  kind := parsed.kind;
  key := parsed.key;
  resolved_key := target;
  label := found_label;
  is_superseded := hops > 0;
  return next;
end;
$$;

comment on function xpms.urn_resolve(text) is
  'Resolves a canon URN to its live row: follows the supersession graph (so urn:xpms:phase:DIS resolves to SCP with is_superseded true) and returns the label. No row means no answer.';

-- Phase code resolution, superseded codes included ---------------------------------------

create or replace function xpms.resolve_phase_code(code text)
returns text
language sql
stable
set search_path = ''
as $$
  select r.resolved_key from xpms.urn_resolve('urn:xpms:phase:' || code) r;
$$;

comment on function xpms.resolve_phase_code(text) is
  'The live phase code for a phase code, following supersession (DIS and DSN resolve to SCP). NULL for an unknown code.';
