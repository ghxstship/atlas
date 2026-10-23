-- pgTAP: 1453, live co-editing (A88, RRR-133, Section 5, Section 7.3). Documents follow the row they belong to:
-- readers open them, writers append updates and compact, compaction writes an SOP's text into its row, a text
-- changed outside the editor starts a new generation that refuses stale updates, and the Realtime channel of a
-- document is authorized by the same checks.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

select has_table('app', 'doc_snapshots', 'documents keep their snapshot');
select has_table('app', 'doc_updates', 'and their updates since it');

select pg_temp.as_user('carol');
with x as (insert into app.sops (org_id, code, title, body) values (pg_temp.id('org_a'), 'SOP-101', 'Working at Height', 'Wear a harness.') returning id)
insert into world select 'sop', id from x;

create temporary table opened (who text, doc jsonb);
grant all on opened to public;
insert into opened select 'carol', app.open_doc('app.sops', pg_temp.id('sop'), 'body');
insert into world select 'doc', (doc ->> 'doc_id')::uuid from opened where who = 'carol';

select is((select doc ->> 'generation' from opened where who = 'carol'), '1', 'a document starts in generation 1');
select is((select doc ->> 'seed_text' from opened where who = 'carol'), 'Wear a harness.', 'seeded from the SOP''s procedure');
select is((select doc ->> 'can_edit' from opened where who = 'carol'), 'true', 'a writer may edit');
select is(app.append_doc_update(pg_temp.id('doc'), 1, encode('\x0102'::bytea, 'base64')), 1::bigint, 'updates are numbered from 1');
select is(app.append_doc_update(pg_temp.id('doc'), 1, encode('\x0304'::bytea, 'base64')), 2::bigint, 'and in order');
select is(app.open_doc('app.sops', pg_temp.id('sop'), 'body', 1) -> 'updates' -> 0 ->> 'seq', '2',
  'a reconnecting editor reads only what it missed');

-- Readers read, writers write -------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
insert into opened select 'gina', app.open_doc('app.sops', pg_temp.id('sop'), 'body');
select is((select jsonb_array_length(doc -> 'updates') from opened where who = 'gina'), 2, 'a reader loads the updates');
select is((select doc ->> 'can_edit' from opened where who = 'gina'), 'false', 'but a Viewer may not edit without knowledge.sop.write');
select throws_ok($$select app.append_doc_update((select id from world where key = 'doc'), 1, 'AQI=')$$, '42501', null,
  'so a reader''s update is refused');
select is((select count(*)::int from app.doc_updates where doc_id = pg_temp.id('doc')), 2, 'a reader sees the stored updates through the row''s policy');
select pg_temp.as_user('xavier');
select throws_ok($$select app.open_doc('app.sops', (select id from world where key = 'sop'), 'body')$$, '42501', null,
  'another org opens nothing');
select is((select count(*)::int from app.doc_snapshots), 0, 'nor reads the snapshot');

-- Compaction writes the text into the row ---------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.compact_doc(pg_temp.id('doc'), 1, encode('\x0a0b'::bytea, 'base64'), 2, 'Wear a harness. Clip in above you.') ->> 'compacted',
  'true', 'compaction folds the updates into the snapshot');
select is((select body from app.sops where id = pg_temp.id('sop')), 'Wear a harness. Clip in above you.',
  'and writes the text into the SOP, so readers see it');
select is((select count(*)::int from app.doc_updates where doc_id = pg_temp.id('doc')), 0, 'the folded updates are removed');

-- A text changed outside the editor starts a new generation -------------------------------------------------------------
update app.sops set body = 'Edited in a form.' where id = pg_temp.id('sop');
select is(app.open_doc('app.sops', pg_temp.id('sop'), 'body') ->> 'generation', '2',
  'the next open reseeds the document from the row in generation 2');
select throws_ok($$select app.append_doc_update((select id from world where key = 'doc'), 1, 'AQI=')$$, 'XR001',
  'coedit_generation_changed: The document was reloaded from its row; open it again.',
  'an editor still on generation 1 is refused and reloads');

-- The Realtime channel follows the same checks --------------------------------------------------------------------------
select ok(to_regclass('realtime.messages') is null
  or (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages'
      and policyname in ('xos_doc_channel_read', 'xos_doc_channel_write')) = 2,
  'doc:<id> channels are authorized for broadcast and presence by the row''s access');
select pg_temp.as_platform();

select * from finish();
rollback;
