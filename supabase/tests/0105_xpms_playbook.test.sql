-- pgTAP: Playbook import (Section 2.1). Registry completeness, Standard Library and
-- Production Template contents, privacy of the template, and em dash refusal on verbiage.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(16);

select is((select count(*)::int from xpms.playbook_sheet), 46, 'all 45 working sheets and the Cover Page are registered');
select is(
  (select count(*)::int from xpms.playbook_sheet s
    where s.data_row_count <> coalesce((select count(*) from xpms.production_template_rows t where t.sheet_name = s.sheet_name), 0)
      and s.destination = 'production-template'),
  0, 'every Production Template data row is stored'
);
select ok(
  not exists (select 1 from xpms.playbook_column c where c.disposition not in ('field', 'computed', 'presentation')),
  'every Playbook column has one disposition'
);
select ok(
  not exists (select 1 from xpms.playbook_sheet s
               where (select count(*) from xpms.playbook_column c where c.sheet_name = s.sheet_name) = 0),
  'every sheet has its columns mapped'
);
select is((select count(*)::int from xpms.std_verbiage), 213, 'Verbiage Library rows are in the Standard Library');
select is((select count(*)::int from xpms.std_enumeration), 91, 'Enumerations keep every row the rulings do not retire');
select is((select is_published from xpms.production_template where template_code = 'XOS-4.0'), false, 'the Production Template is unpublished at import');
select is((select count(*)::int from xpms.intake where intake_state = 'Proposed') > 0, true, 'Playbook differences wait in intake');
select throws_ok(
  format($$insert into xpms.std_verbiage (source_row, record_id, verbiage) values (999, 'VRB-999', %L)$$, 'A' || chr(8212) || 'B'),
  '23514', null, 'verbiage text refuses an em dash'
);

set local role authenticated;
select lives_ok($$select count(*) from xpms.std_verbiage$$, 'authenticated can read the Standard Library');
select throws_ok($$insert into xpms.std_verbiage (source_row, record_id) values (998, 'VRB-998')$$, '42501', null, 'authenticated cannot write the Standard Library');
select throws_ok($$select count(*) from xpms.production_template_rows$$, '42501', null, 'the Production Template is private');
select throws_ok($$select count(*) from xpms.production_template_metadata$$, '42501', null, 'the template metadata is private');
select throws_ok($$select count(*) from xpms.v_playbook_projects$$, '42501', null, 'round-trip export views are private');
select lives_ok($$select count(*) from xpms.intake$$, 'authenticated can read intake proposals');
reset role;

select is(xpms.playbook_checksum('Projects'), (select checksum_sha256::text from xpms.playbook_sheet where sheet_name = 'Projects'), 'an unruled sheet exports to its source checksum');

select * from finish();
rollback;
