-- pgTAP: chat message translation cache and its setting (A80, RRR-125, finding A65-012, Section 4.9 Chat).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(10);

create temporary table c (key text primary key, id uuid);
grant select, insert on c to public;

select pg_temp.as_user('dave');
insert into c values ('dm', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('erin@org_a')));
insert into c values ('m1', app.send_chat_message((select id from c where key = 'dm'), 'Hola equipo, nos vemos a las 6.', 'Text', 'es-US'));

select pg_temp.as_platform();
select is(app.message_translation_enabled(pg_temp.id('org_a')), false, 'message translation is off by default');
select throws_ok($$select app.record_chat_message_translation((select id from c where key = 'm1'), 'en-US', 'Hi team, see you at 6.', 'es-US', 'google')$$,
  'XR001', null, 'nothing is cached while the org has it off');

select pg_temp.as_user('bob');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'communication.message_translation', 'Organization', pg_temp.id('org_a'), null, true, null, false)$$,
  'an admin turns message translation on');

select pg_temp.as_platform();
select is(app.message_translation_enabled(pg_temp.id('org_a')), true, 'the org now translates');
select lives_ok($$select app.record_chat_message_translation((select id from c where key = 'm1'), 'en-US', 'Hi team, see you at 6.', 'es-US', 'google')$$,
  'the service caches a translation');
select app.record_chat_message_translation((select id from c where key = 'm1'), 'en-US', 'Hi team, see you at six.', 'es-US', 'google');
select is((select count(*)::integer from app.chat_message_translations where chat_message_id = (select id from c where key = 'm1')), 1,
  'one translation per message and language');

select pg_temp.as_user('erin');
select is((select body from app.chat_message_translations), 'Hi team, see you at six.', 'a member of the conversation reads the translation');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.chat_message_translations), 0, 'someone outside the conversation does not');

select pg_temp.as_user('dave');
select app.edit_chat_message((select id from c where key = 'm1'), 'Hola equipo, nos vemos a las 7.');
select pg_temp.as_platform();
select is((select count(*)::integer from app.chat_message_translations where deleted_at is null), 0,
  'editing the message retires its cached translations');

select pg_temp.as_user('dave');
select throws_ok($$select app.record_chat_message_translation((select id from c where key = 'm1'), 'en-US', 'x', null, 'google')$$, '42501', null,
  'only the service writes translations');

select * from finish();
rollback;
