-- 0108_xpms_playbook_helpers.sql
-- A01 Canon. Helpers the Playbook export views use to reproduce formula columns
-- (Section 2.1): Cover Page references and spreadsheet time arithmetic.

create or replace function xpms.pb_cover(source_row integer, column_ordinal integer)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(xpms.pb_cell(m.value_text, m.value_kind), '')
    from xpms.production_template_metadata m
   where m.template_code = 'XOS-4.0'
     and m.source_row = pb_cover.source_row
     and m.column_ordinal = pb_cover.column_ordinal;
$$;
comment on function xpms.pb_cover(integer, integer) is
  'Normalized value of a Cover Page cell of the XOS 4.0 Production Template, as a formula reference such as ''Cover Page''!$C$7 reads it.';

create or replace function xpms.pb_hours(from_value text, to_value text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when from_value is null or to_value is null then null
    when from_value ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}$' and to_value ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}$'
      then extract(epoch from (to_value::time - from_value::time)) / 3600
    else extract(epoch from (to_value::timestamp - from_value::timestamp)) / 3600
  end;
$$;
comment on function xpms.pb_hours(text, text) is
  'Hours from one normalized time or date-time to another, as (B - A) * 24 computes it in a spreadsheet; NULL when either is empty.';
