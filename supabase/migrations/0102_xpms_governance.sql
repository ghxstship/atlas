-- 0102_xpms_governance.sql
-- A01 Canon. Governance rules on the tables created in 0101 (Section 3.13).
-- Runs before the seed so the seed itself is checked.

-- Supersession graph stays acyclic ----------------------------------------------
-- Following successor codes from the new edge must never lead back to its code.

create or replace function xpms.assert_supersession_acyclic()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_code text := new.successor_code;
  hops integer := 0;
begin
  while current_code is not null loop
    if current_code = new.code then
      raise exception 'Supersession of % code % by % would close a cycle', new.domain, new.code, new.successor_code
        using errcode = 'check_violation';
    end if;
    hops := hops + 1;
    if hops > 1000 then
      raise exception 'Supersession chain from % code % is longer than 1000 hops', new.domain, new.code
        using errcode = 'check_violation';
    end if;
    select s.successor_code into current_code
      from xpms.supersession s
     where s.domain = new.domain
       and s.code = current_code
       and not (s.domain = new.domain and s.code = new.code);
    if not found then
      current_code := null;
    end if;
  end loop;
  return new;
end;
$$;

comment on function xpms.assert_supersession_acyclic() is
  'Trigger: refuses a supersession edge that would make the supersession graph cyclic (Section 3.13).';

create trigger supersession_acyclic
  before insert or update on xpms.supersession
  for each row execute function xpms.assert_supersession_acyclic();

-- A superseded code never names a live phase, and a successor phase must exist ------

create or replace function xpms.assert_phase_supersession()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.domain = 'phase' then
    if exists (select 1 from xpms.dim_phase p where p.phase_code = new.code) then
      raise exception 'Phase % is live and cannot be recorded as superseded', new.code
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from xpms.dim_phase p where p.phase_code = new.successor_code)
       and not exists (select 1 from xpms.supersession s where s.domain = 'phase' and s.code = new.successor_code) then
      raise exception 'Successor phase % does not exist', new.successor_code
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function xpms.assert_phase_supersession() is
  'Trigger: a superseded phase code is never a live phase, and its successor is a phase or a recorded superseded code.';

create trigger supersession_phase_codes
  before insert or update on xpms.supersession
  for each row execute function xpms.assert_phase_supersession();

-- Provenance max_confidence is an economics assertion word -------------------------

create or replace function xpms.assert_provenance_confidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from xpms.dim_assertion_word w where w.domain = 'economics' and w.word = new.max_confidence
  ) then
    raise exception 'max_confidence % is not an economics assertion word', new.max_confidence
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

comment on function xpms.assert_provenance_confidence() is
  'Trigger: dim_provenance.max_confidence names an economics assertion word (Bible tabs 19 and 22).';

create trigger provenance_confidence
  before insert or update on xpms.dim_provenance
  for each row execute function xpms.assert_provenance_confidence();

-- Price band assertion words come from the economics domain -------------------------

create or replace function xpms.assert_band_assertion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assertion_word is not null and not exists (
    select 1 from xpms.dim_assertion_word w where w.domain = 'economics' and w.word = new.assertion_word
  ) then
    raise exception 'Price band assertion % is not an economics assertion word', new.assertion_word
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

comment on function xpms.assert_band_assertion() is
  'Trigger: element_price_bands.assertion_word is NULL or an economics assertion word.';

create trigger band_assertion
  before insert or update on xpms.element_price_bands
  for each row execute function xpms.assert_band_assertion();
