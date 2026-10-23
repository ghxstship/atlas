-- pgTAP: migration 1541, canon label translations (A97, RRR-142, Section 15, ADR 0053). Every registered
-- vocabulary answers a label for every code; es-US carries the labels the app catalogs held; a locale without a
-- translation, a pseudo-locale or an unknown locale reads en-US and says so; codes are never translated; a label
-- for a code the vocabulary lacks, or an en-US label, is refused; loading replaces a locale's labels; canon stays
-- read-only to signed-in people and closed to anonymous ones.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

select pg_temp.as_platform();
select is((select count(*)::int from xpms.canon_vocabulary), 20, 'twenty canon vocabularies are translatable');
select is(
  (select count(*)::int from xpms.canon_vocabulary v
   where (select count(*) from xpms.canon_labels(v.vocabulary, 'es-US')) = 0), 0,
  'every vocabulary answers a label for its codes');
select results_eq(
  $$select (vocabulary::text) collate "default", count(*)::int from xpms.canon_label where locale_code = 'es-US' group by 1 order by 1$$,
  $$values ('phase'::text, 9), ('recordClass', 5), ('recordKind', 26), ('recordState', 9), ('recordSubtype', 124), ('workerClassification', 5)$$,
  'es-US carries the canon labels the app catalogs already held');

-- Reading ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq(
  $$select code, label, locale_code, translated from xpms.canon_labels('phase', 'es-US') where code = 'SCP'$$,
  $$values ('SCP'::text, 'Alcance'::text, 'es-US'::text, true)$$,
  'a translated label reads in the locale and keeps its code');
select results_eq(
  $$select label, locale_code, translated from xpms.canon_labels('department', 'es-US') where code = '0000'$$,
  $$values ('Executive'::text, 'en-US'::text, false)$$,
  'an untranslated label falls back to en-US and says so');
select is(xpms.canon_label_of('phase', 'SCP', 'fr-FR'), 'Scope', 'a Beta locale with no translation yet reads en-US');
select is(xpms.canon_label_of('phase', 'SCP', 'en-XA'), 'Scope', 'a pseudo-locale reads en-US');
select is(xpms.canon_label_of('recordSubtype', 'Approval/Design', 'es-US'), 'Diseño',
  'a subtype is keyed by its kind and its own code');
select is(xpms.canon_label_of('phase', 'NOPE', 'es-US'), null, 'a code the vocabulary lacks has no label');
select is(
  (select count(*)::int from xpms.canon_labels('jobTitle', 'es-US') l join xpms.role r on r.role_code::text = l.code),
  (select count(*)::int from xpms.role), 'codes are never translated: every job title code comes back as stored');
select throws_ok($$select * from xpms.canon_labels('nonsense', 'es-US')$$, '22023', null,
  'an unknown vocabulary is refused');

-- Writing ---------------------------------------------------------------------------------------------------------
select throws_ok($$insert into xpms.canon_label (vocabulary, code, locale_code, label, provenance) values ('phase', 'SCP', 'fr-FR', 'Périmètre', 'human')$$,
  '42501', null, 'a signed-in person cannot write canon labels');
select throws_ok($$select xpms.put_canon_labels('phase', 'fr-FR', 'human', '{"SCP":"Périmètre"}'::jsonb)$$,
  '42501', null, 'nor load them');
select pg_temp.as_platform();
select throws_ok($$insert into xpms.canon_label (vocabulary, code, locale_code, label, provenance) values ('phase', 'XYZ', 'fr-FR', 'Inconnu', 'human')$$,
  '23503', null, 'a label for a code the vocabulary lacks is refused');
select throws_ok($$insert into xpms.canon_label (vocabulary, code, locale_code, label, provenance) values ('phase', 'SCP', 'en-US', 'Scope', 'human')$$,
  '23514', null, 'en-US is the canon table''s own label, never a translation');
select is(xpms.put_canon_labels('phase', 'fr-FR', 'machine', '{"SCP":"Périmètre","ADV":"Avance"}'::jsonb), 2,
  'a migration loads a locale''s labels');
select xpms.put_canon_labels('phase', 'fr-FR', 'machine', '{"SCP":"Portée"}'::jsonb);
select results_eq(
  $$select code::text collate "default", label::text from xpms.canon_label where vocabulary = 'phase' and locale_code = 'fr-FR'$$,
  $$values ('SCP'::text, 'Portée'::text)$$,
  'loading again replaces the locale''s labels: changed ones change, dropped ones go');

select pg_temp.as_anon();
select throws_ok($$select count(*) from xpms.canon_label$$, '42501', null, 'anonymous visitors read no canon labels');

select * from finish();
rollback;
