-- pgTAP: xpms canon (A01). Counts, ordering, 4.0 grammar, supersession, invariant 24
-- (em dash refusal), read-only canon, refusal semantics and function hygiene.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(74);

-- Counts (Section 2) -------------------------------------------------------------------
select is((select count(*)::int from xpms.dim_department), 10, '10 departments');
select is((select count(*)::int from xpms.dim_discipline), 114, '114 disciplines');
select is((select count(*)::int from xpms.dim_category), 291, '291 categories');
select is((select count(*)::int from xpms.dim_act), 3, '3 acts');
select is((select count(*)::int from xpms.dim_phase), 9, '9 phases');
select is((select count(*)::int from xpms.dim_gate_criterion), 35, '35 gate criteria');
select is((select count(*)::int from xpms.dim_tier), 6, '6 tiers');
select is((select count(*)::int from xpms.dim_tag), 42, '42 tags');
select is((select count(*)::int from xpms.dim_touchpoint), 90, '90 touchpoints');
select is((select count(*)::int from xpms.jurisdiction), 7, '7 jurisdictions');
select is((select count(*)::int from xpms.dim_region), 5, '5 regions');
select is((select count(*)::int from xpms.dim_permit_rule), 22, '22 permit rules');
select is((select count(*)::int from xpms.dim_metric), 39, '39 metrics');
select is((select count(*)::int from xpms.dim_record_kind), 26, '26 record kinds');
select is((select count(*)::int from xpms.dim_record_subtype), 124, '124 record subtypes');
select is((select count(*)::int from xpms.dim_record_state), 9, '9 record states');
select is((select count(*)::int from xpms.dim_role), 61, '61 roles');
select is((select count(*)::int from xpms.dim_counterparty_type), 22, '22 counterparty types');
select is((select count(*)::int from xpms.dim_gl_account), 23, '23 GL accounts');
select is((select count(*)::int from xpms.elements), 1211, '1,211 items');
select is((select count(*)::int from xpms.v_coordinate_matrix), 90, '90 coordinates');
select is((select count(*)::int from xpms.dim_record_class), 5, '5 record classes');

-- Department order and the 4.0 grammar (Sections 3.2 and 3.4, 20.1 item 1) ---------------
select is(
  (select array_agg(dept_code::text order by dept_code) from xpms.dim_department),
  array['0000','1000','2000','3000','4000','5000','6000','7000','8000','9000'],
  'departments sort in numeric order by their code'
);
select is((select department::text from xpms.dim_department where dept_code = '4000'), 'Environment', '4000 is Environment');
select is(
  (select array_agg(phase::text order by gate) from xpms.dim_phase where gate <= 3),
  array['Scope','Engage','Advance'],
  'gates 1 to 3 read Scope, Engage and Advance'
);
select is(
  (select array_agg(phase_code::text order by gate) from xpms.dim_phase),
  array['SCP','ENG','ADV','PRC','BLD','INS','OPR','AMP','CLS'],
  'phase codes in gate order'
);
select is(
  (select array_agg(act_code::text order by ordinal) from xpms.dim_act),
  array['PLAN','BUILD','SHOW'],
  'acts in order'
);
select is(
  (select array_agg(gl.account_code::text order by gl.account_code) from xpms.dim_gl_account gl),
  (select array_agg(gl.account_code::text order by gl.account_code::int) from xpms.dim_gl_account gl),
  'GL accounts: code sort equals numeric sort'
);
select is(
  (select array_agg(disc_code::text order by disc_code) from xpms.dim_discipline),
  (select array_agg(disc_code::text order by replace(disc_code, '.', '')::bigint) from xpms.dim_discipline),
  'disciplines: code sort equals numeric sort'
);
select is(
  (select array_agg(cat_urid::text order by cat_urid) from xpms.dim_category),
  (select array_agg(cat_urid::text order by replace(cat_urid, '.', '')::bigint) from xpms.dim_category),
  'categories: code sort equals numeric sort'
);
select is(
  (select array_agg(criterion_id::text order by ordinal) from xpms.dim_gate_criterion),
  (select array_agg(criterion_id::text order by gate, ordinal) from xpms.dim_gate_criterion),
  'criteria order by gate'
);

-- Superseded codes (Section 3.13) ------------------------------------------------------
select is(xpms.resolve_phase_code('DIS'), 'SCP', 'DIS resolves to SCP');
select is(xpms.resolve_phase_code('DSN'), 'SCP', 'DSN resolves to SCP');
select is(xpms.resolve_phase_code('BLD'), 'BLD', 'a live phase resolves to itself');
select is(xpms.resolve_phase_code('XYZ'), null, 'an unknown phase resolves to nothing');
select ok((select is_superseded from xpms.urn_resolve('urn:xpms:phase:DIS')), 'DIS is reported as superseded');
select ok(not (select is_superseded from xpms.urn_resolve('urn:xpms:phase:SCP')), 'SCP is live');
select is((select label::text from xpms.supersession where domain = 'phase' and code = 'DSN'), 'Design', 'DSN carries its 3.0 label');
select throws_ok(
  $$insert into xpms.supersession values ('phase', 'SCP', 'DIS', 'Scope', 'cycle')$$,
  '23514', null, 'a live phase cannot be superseded'
);
select lives_ok(
  $$insert into xpms.supersession values ('department', 'A', 'B', 'A', 'test edge'), ('department', 'B', 'C', 'B', 'test edge')$$,
  'an acyclic chain is accepted'
);
select throws_ok(
  $$insert into xpms.supersession values ('department', 'C', 'A', 'C', 'closes the loop')$$,
  '23514', null, 'a supersession cycle is refused'
);
select throws_ok(
  $$update xpms.supersession set successor_code = 'A' where domain = 'department' and code = 'B'$$,
  '23514', null, 'an update that makes a self-loop through the chain is refused'
);

-- Invariant 24: no em dash in canon or verbiage text -------------------------------------
select throws_ok(
  format($$insert into xpms.dim_tag values ('TAG-999', 'Compliance', %L)$$, 'A' || chr(8212) || 'B'),
  '23514', null, 'canon text refuses an em dash'
);
select throws_ok(
  format($$insert into xpms.dim_tag values (%L, 'Compliance', 'Fine')$$, 'TAG' || chr(8212) || '1'),
  '23514', null, 'canon codes refuse an em dash'
);
select is(
  (select count(*)::int from xpms.dim_metric where strpos(item, chr(8212)) > 0 or strpos(coalesce(qualifier, ''), chr(8212)) > 0),
  0, 'no seeded metric holds an em dash'
);
select lives_ok(
  $$insert into xpms.dim_tag values ('TAG-998', 'Compliance', 'Status is a permitted word')$$,
  'the word status is not banned (Section 3.6)'
);

-- Refusal semantics (Section 3.7) ----------------------------------------------------------
select is(xpms.assert_or_refuse('QUOTED', 'economics', true), 'QUOTED', 'an attested claim passes');
select is(xpms.assert_or_refuse(null, 'economics', false), 'NO_ANSWER', 'an absent claim is no answer');
select is(xpms.assert_or_refuse(null, 'capability', true), 'REFUSE', 'an absent critical claim refuses');
select is(xpms.assert_or_refuse('UNKNOWN', 'capability', true), 'REFUSE', 'UNKNOWN against a critical requirement refuses');
select is(xpms.assert_or_refuse('MODELED', 'economics', true), 'UNRATIFIED', 'an unattested critical claim is unratified');
select is(xpms.assert_or_refuse('CODE', 'economics', false), 'REFUSE', 'a word from another domain refuses');
select is(xpms.band_effective_confidence('QUOTED', '2025-01-01', null, '2025-06-01'), 'QUOTED', 'band holds under 12 months');
select is(xpms.band_effective_confidence('QUOTED', '2025-01-01', null, '2026-02-01'), 'PUBLISHED', 'band degrades one step at 12 months');
select is(xpms.band_effective_confidence('QUOTED', '2023-01-01', null, '2025-06-01'), 'MODELED', 'band degrades to MODELED at 24 months');
select is(xpms.band_effective_confidence('QUOTED', '2022-01-01', null, '2025-06-01'), 'EXPIRED', 'band expires at 36 months');
select is(xpms.band_effective_confidence(null, '2022-01-01', null, '2025-06-01'), 'NO_ANSWER', 'an unrated band is no answer');
select is(xpms.resolve_gtin('00012345678905'), 'NO_ANSWER', 'an unbound GTIN is no answer');
select is(xpms.resolve_gtin('12ab'), 'REFUSE', 'a malformed GTIN refuses');
select ok(not xpms.may_write_field('0000.51.01-XOS-004', 'item', 'agent'), 'agent cannot overwrite a populated canon field');
select ok(xpms.may_write_field('0000.51.01-XOS-004', 'item', 'human'), 'a human ratifier may overwrite');
select ok(xpms.may_write_field('0000.51.01-XOS-004', 'common_name', 'provider'), 'any provenance may populate an empty field');
select ok(not xpms.may_write_field('0000.51.01-XOS-004', 'no_such_field', 'human'), 'an unknown field refuses');
select is(xpms.urid_segment('4000.08.01', 'discipline'), '4000.08', 'URID discipline segment');
select ok(xpms.is_extension_urid('6000.53.01') and not xpms.is_extension_urid('4000.08.01'), 'extension range is .50 to .99');
select is(
  (select count(*)::int from xpms.element_price_bands where amount_minor = 0 and element_id = '0000.51.01-XOS-004'),
  0, 'a blank canon price is stored as no band, never zero'
);

-- Read-only canon: authenticated reads, nobody else writes, anon denied -------------------
set local role authenticated;
select is((select count(*)::int from xpms.dim_phase), 9, 'authenticated can read canon');
select throws_ok($$insert into xpms.dim_tier values ('07', 'Orbital')$$, '42501', null, 'authenticated cannot insert canon');
select throws_ok($$update xpms.dim_department set department = 'Build' where dept_code = '4000'$$, '42501', null, 'authenticated cannot update canon');
select throws_ok($$delete from xpms.elements$$, '42501', null, 'authenticated cannot delete canon');
reset role;
set local role anon;
select throws_ok($$select count(*) from xpms.dim_phase$$, '42501', null, 'anon cannot read canon');
reset role;

-- Function hygiene and documentation --------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'xpms' and not coalesce(p.proconfig @> array['search_path=""'], false)),
  0, 'every xpms function pins search_path to empty'
);
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'xpms' and c.relkind in ('r', 'v') and obj_description(c.oid, 'pg_class') is null),
  0, 'every xpms table and view has a comment'
);
select is(
  (select count(*)::int from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'xpms' and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped
      and col_description(c.oid, a.attnum) is null),
  0, 'every xpms column has a comment'
);

select * from finish();
rollback;
