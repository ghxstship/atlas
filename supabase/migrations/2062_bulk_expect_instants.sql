-- 2062_bulk_expect_instants.sql
--
-- A106 (RRR-151, ADR 0044; follow-up of A88). A bulk row's expect (compare-and-set, 1451) is compared with the row as
-- JSON. A stored instant serializes as '2026-10-08T14:30:00+00:00', so an API client that sent the same instant as
-- '2026-10-08T14:30:00Z' got bulk_stale on every row although nothing had changed.
--
--   * private.bulk_same_instant says whether two JSON strings are the same instant. Both must be full ISO 8601
--     timestamps with a time and an offset; a date alone, a timestamp without an offset or any other text is never
--     equal by this test, so it changes nothing for non-instant fields.
--   * private.bulk_check_expect (latest definition 1451, restated here) refuses only when the values differ as JSON
--     and are not the same instant. Every bulk RPC (1451, 2150, 2151, 2160) calls it, so they all accept either form.

create function private.bulk_same_instant(p_a jsonb, p_b jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_pattern constant text := '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$';
begin
  if jsonb_typeof(p_a) is distinct from 'string' or jsonb_typeof(p_b) is distinct from 'string'
     or (p_a #>> '{}') !~ v_pattern or (p_b #>> '{}') !~ v_pattern then
    return false;
  end if;
  begin
    return (p_a #>> '{}')::timestamptz = (p_b #>> '{}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return false;
  end;
end;
$$;

comment on function private.bulk_same_instant(jsonb, jsonb) is 'Whether two JSON values are strings naming the same instant as full ISO 8601 timestamps with an offset (2026-10-08T14:30:00Z and 2026-10-08T14:30:00+00:00 are). False for anything else, a date alone or a timestamp without an offset included.';
revoke all on function private.bulk_same_instant(jsonb, jsonb) from public, anon, authenticated;

create or replace function private.bulk_check_expect(p_row jsonb, p_expect jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_key text;
begin
  for v_key in select k from jsonb_object_keys(coalesce(p_expect, '{}'::jsonb)) k loop
    if (p_row -> v_key) is distinct from (p_expect -> v_key)
       and not private.bulk_same_instant(p_row -> v_key, p_expect -> v_key) then
      perform private.refuse('bulk_stale', 'Someone changed this row after you loaded it; reload to see the change.');
    end if;
  end loop;
end;
$$;

comment on function private.bulk_check_expect(jsonb, jsonb) is 'Compare-and-set for a bulk row: refuses with bulk_stale when a field no longer holds the value the caller saw. An instant matches in any ISO 8601 form with an offset (Z or +00:00).';
revoke all on function private.bulk_check_expect(jsonb, jsonb) from public, anon, authenticated;
