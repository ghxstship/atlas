-- 0106_xpms_playbook_functions.sql
-- A01 Canon. Normalization and checksum functions for the Playbook round-trip proof
-- (Section 2.1, Section 18 gate 14). They are the SQL twins of canon/import/src/normalize.ts:
-- whitespace, number format and date format are normalized and nothing else.

create or replace function xpms.pb_text(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(btrim(regexp_replace(value, '[ \t\n\r\f\v' || chr(160) || ']+', ' ', 'g')), '');
$$;
comment on function xpms.pb_text(text) is 'Normalized text: whitespace runs collapse to one space and are trimmed; NULL is empty.';

create or replace function xpms.pb_num(value numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when value is null then '' else pg_catalog.trim_scale(round(value, 10))::text end;
$$;
comment on function xpms.pb_num(numeric) is 'Normalized number: at most ten decimals, no trailing zeros, no exponent; NULL is empty.';

create or replace function xpms.pb_bool(value boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when value is null then '' when value then 'TRUE' else 'FALSE' end;
$$;
comment on function xpms.pb_bool(boolean) is 'Normalized boolean: TRUE or FALSE; NULL is empty.';

create or replace function xpms.pb_date(value date)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(to_char(value, 'YYYY-MM-DD'), '');
$$;
comment on function xpms.pb_date(date) is 'Normalized date: YYYY-MM-DD; NULL is empty.';

create or replace function xpms.pb_ts(value timestamp)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when value is null then ''
    when value::time = '00:00:00'::time then to_char(value, 'YYYY-MM-DD')
    else to_char(value, 'YYYY-MM-DD"T"HH24:MI:SS')
  end;
$$;
comment on function xpms.pb_ts(timestamp) is 'Normalized date-time: YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD at midnight; NULL is empty.';

create or replace function xpms.pb_time(value time)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(to_char(value, 'HH24:MI:SS'), '');
$$;
comment on function xpms.pb_time(time) is 'Normalized time: HH:MM:SS; NULL is empty.';

create or replace function xpms.pb_cell(value text, kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when value is null then ''
    when kind = 'number' then xpms.pb_num(value::numeric)
    when kind in ('string', 'error') then xpms.pb_text(value)
    else value
  end;
$$;
comment on function xpms.pb_cell(text, text) is 'Normalized form of a stored Playbook cell given its kind.';

create or replace function xpms.pb_n(value text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when value is null or btrim(value) = '' then null else value::numeric end;
$$;
comment on function xpms.pb_n(text) is 'Numeric value of a normalized cell; an empty cell is NULL, never zero.';

create or replace function xpms.pb_overlay(sheet text, source_row integer, source_column text, canon text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when i.source_row is null then canon else i.proposed_value end
    from (select 1) one
    left join xpms.intake i
      on i.source_file = 'XOS-4.0_Production-Playbook_2026.xlsx'
     and i.source_sheet = pb_overlay.sheet
     and i.source_row = pb_overlay.source_row
     and i.source_column = pb_overlay.source_column;
$$;
comment on function xpms.pb_overlay(text, integer, text, text) is
  'The Playbook value of a mirrored cell: the proposal held in intake when the Playbook disagrees with canon, else the canon value.';

create or replace function xpms.playbook_lines(sheet text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  view_name text;
  header_line text;
  body text;
begin
  select 'v_playbook_' || s.sheet_key into view_name from xpms.playbook_sheet s where s.sheet_name = playbook_lines.sheet;
  if view_name is null then
    return null;
  end if;
  select array_to_json(coalesce(array_agg(coalesce(c.header, '') order by c.ordinal), array[]::text[]))::text
    into header_line
    from xpms.playbook_column c
   where c.sheet_name = playbook_lines.sheet;
  execute format(
    'select string_agg(array_to_json(array[v.source_row::text] || v.cells)::text, E''\n'' order by v.source_row) from xpms.%I v',
    view_name
  ) into body;
  return header_line || coalesce(E'\n' || body, '');
end;
$$;
comment on function xpms.playbook_lines(text) is
  'The checksum lines of a sheet exported from the database: the header array, then one array per row holding the row number and every normalized cell.';

create or replace function xpms.playbook_checksum(sheet text)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(xpms.playbook_lines(sheet), 'UTF8'), 'sha256'), 'hex');
$$;
comment on function xpms.playbook_checksum(text) is
  'SHA-256 of the sheet as exported from the database; equals the source checksum when the round trip loses nothing.';
