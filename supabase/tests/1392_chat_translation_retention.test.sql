-- pgTAP: migration 1392, a cached chat translation leaves with its message (RRR-125). The nightly purge of chat
-- messages past communication.message_retention_days (1324) deletes a translated message, its live translation and
-- a retired one, instead of failing the org's whole purge on the foreign key from app.chat_message_translations (1363).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

create temporary table c (key text primary key, id uuid);
grant select, insert on c to public;

select pg_temp.as_user('dave');
insert into c values ('dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('erin@org_a')));
insert into c values ('m1', app.send_chat_message((select id from c where key = 'dm'), 'Hola equipo, nos vemos a las 6.', 'Text', 'es-US'));
insert into c values ('m2', app.send_chat_message((select id from c where key = 'dm'), 'Gracias.', 'Text', 'es-US'));

select pg_temp.as_user('bob');
select app.set_setting(pg_temp.id('org_a'), 'communication.message_translation', 'Organization', pg_temp.id('org_a'), null, true, null, false);
select app.set_setting(pg_temp.id('org_a'), 'communication.message_retention_days', 'Organization', pg_temp.id('org_a'), p_value_integer => 30);

select pg_temp.as_platform();
-- m1 has a retired translation (its text was edited) and a live one; m2 has a live one.
select app.record_chat_message_translation((select id from c where key = 'm1'), 'en-US', 'Hi team, see you at 6.', 'es-US', 'google');
select pg_temp.as_user('dave');
select app.edit_chat_message((select id from c where key = 'm1'), 'Hola equipo, nos vemos a las 7.');
select pg_temp.as_platform();
select app.record_chat_message_translation((select id from c where key = 'm1'), 'en-US', 'Hi team, see you at 7.', 'es-US', 'google');
select app.record_chat_message_translation((select id from c where key = 'm2'), 'en-US', 'Thanks.', 'es-US', 'google');
select is((select count(*)::integer from app.chat_message_translations
           where chat_message_id in ((select id from c where key = 'm1'), (select id from c where key = 'm2'))), 3,
  'three cached translations: a retired and a live one for the edited message, a live one for the other');

select is((select confdeltype::text from pg_catalog.pg_constraint
           where conname = 'chat_message_translations_chat_message_id_fkey' and conrelid = 'app.chat_message_translations'::regclass), 'c',
  'the translation''s reference to its message cascades on delete');

select is(private.purge_chat_messages_past_retention(now() + interval '31 days'), 2::bigint,
  'the purge deletes both translated messages older than the org''s 30 days');
select is((select count(*)::integer from app.chat_messages
           where id in ((select id from c where key = 'm1'), (select id from c where key = 'm2'))), 0, 'the messages are gone');
select is((select count(*)::integer from app.chat_message_translations
           where chat_message_id in ((select id from c where key = 'm1'), (select id from c where key = 'm2'))), 0,
  'their translations, live and retired, are gone with them');
select ok(not exists (select 1 from private.retention_runs where table_name = 'app.chat_messages' and error_message is not null),
  'no org failed the purge');
select ok(exists (select 1 from private.retention_runs where table_name = 'app.chat_messages' and action = 'purge' and rows_affected = 2),
  'the run is recorded with the messages deleted');

select * from finish();
rollback;
