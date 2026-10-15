-- pgTAP: Compass can record ITF-14 and EAN-8 scans (0933).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(1);

select ok(
  array['EAN-8', 'ITF-14']::text[] <@ enum_range(null::app.scan_symbology)::text[],
  'the scan symbologies include ITF-14 and EAN-8'
);

select * from finish();
rollback;
