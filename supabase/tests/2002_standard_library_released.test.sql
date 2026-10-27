-- pgTAP: migration 2002, owner decisions of 2026-10-24 on Linear RRR-67. Every org receives all 34 Standard Library
-- SOPs and 34 documents: nothing is withheld, a signed-in caller reads every row through canon, and the SOPs and
-- documents once written from the CSMIA26 activation name neither its client nor its site, agencies or permits.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(6);

select is(private.standard_library_withheld('sops'), '{}'::text[], 'no SOP is withheld');
select is(private.standard_library_withheld('document_library'), '{}'::text[], 'no document is withheld');

select pg_temp.as_user('alice');
select is((select count(*)::int from xpms.std_sop), 34, 'a member reads all 34 standard SOPs');
select is((select count(*)::int from xpms.std_document_library), 34, 'a member reads all 34 standard documents');
select is((select document_name from xpms.std_document_library where record_id = 'DOC-002'), 'Special Assembly Occupancy Permit',
  'a document written from the activation reads generically');
select is(
  (select count(*)::int from xpms.std_sop s
   where to_jsonb(s)::text ~* '(spotify|wynwood|miami|biscayne|76th st|BD-2026-08914|EL-2026-04421)'),
  0, 'no SOP names the activation''s client, site, agencies or permits');
select pg_temp.as_platform();

select * from finish();
rollback;
