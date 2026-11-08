-- pgTAP: migration 6892, the objectionable language filter checks only what a person typed. A person's clean message
-- is never refused for text the system adds to it or relays from someone else: an automatic out-of-office reply is
-- filtered where its author types it, as a setting, and one that holds a listed term (saved before the filter, or
-- holding a term added since) is not relayed, while the message it answers is sent as written. An edit to an automatic
-- reply is typed, and is checked. A shout-out's post carries the recipient's name as its title, which the sender never
-- typed, so a clean shout-out is sent whatever the name holds, and the shout-out itself is still checked.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- The automatic reply is filtered where it is typed -----------------------------------------------------------------
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.enabled', null, p_value_boolean => true);
select throws_ok($$select app.set_personal_setting('me.out_of_office.auto_reply', null, p_value_text => 'Away. Ask the wetbacks on the dock.')$$,
  'XR001', 'content_objectionable: This contains language that is not allowed here. Change the wording and try again.',
  'an automatic reply with a slur is refused where its author types it');
select lives_ok($$select app.set_personal_setting('me.out_of_office.auto_reply', null, p_value_text => 'Away at the Harbor show until Monday.')$$,
  'an automatic reply without one is saved');
select lives_ok($$select app.set_personal_setting('me.out_of_office.ends_on', null, p_value_text => to_char(current_date + 2, 'YYYY-MM-DD'))$$,
  'other out-of-office settings are not filtered');

-- A clean message is sent whatever the automatic reply it answers holds -----------------------------------------------
-- The reply was saved before its term was listed, as a reply saved before 6890 was.
select pg_temp.as_platform();
insert into private.objectionable_terms (term, language) values ('harbor', 'en');
select pg_temp.as_user('alice');
insert into k select 'conv', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('bob@org_a'));
select lives_ok($$insert into k select 'msg', app.send_chat_message((select id from k where key = 'conv'), 'Can you sign off the rigging plan?')$$,
  'a clean direct message is sent when the automatic reply it answers holds a listed term');
select is((select body from app.chat_messages where id = (select id from k where key = 'msg')), 'Can you sign off the rigging plan?',
  'as written');
select is((select count(*)::int from app.chat_messages where conversation_id = (select id from k where key = 'conv') and auto_reply), 0,
  'and the reply that holds the term is not relayed');
select throws_ok($$select app.send_chat_message((select id from k where key = 'conv'), 'The harbor crew is late.')$$,
  'XR001', null, 'what the sender types is still checked');

select pg_temp.as_user('bob');
select lives_ok($$select app.clear_personal_setting('me.out_of_office.auto_reply')$$,
  'a saved reply that now holds a term can still be cleared');
select pg_temp.as_platform();
delete from private.objectionable_terms where term = 'harbor';
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.auto_reply', null, p_value_text => 'Away at the Harbor show until Monday.');

select pg_temp.as_user('carol');
insert into k select 'conv2', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('bob@org_a'));
select lives_ok($$select app.send_chat_message((select id from k where key = 'conv2'), 'Is the truck schedule final?')$$,
  'a clean direct message is sent');
select is((select body from app.chat_messages where conversation_id = (select id from k where key = 'conv2') and auto_reply),
  'Away at the Harbor show until Monday.', 'with the automatic reply that passes, as written');

-- An edit to an automatic reply is typed ----------------------------------------------------------------------------
select pg_temp.as_platform();
insert into k select 'reply', x.id from app.chat_messages x where x.conversation_id = (select id from k where key = 'conv2') and x.auto_reply;
select pg_temp.as_user('bob');
select throws_ok($$select app.edit_chat_message((select id from k where key = 'reply'), 'Away, sudaca.')$$,
  'XR001', null, 'editing an automatic reply into a slur is refused');
select lives_ok($$select app.edit_chat_message((select id from k where key = 'reply'), 'Away until Tuesday now.')$$,
  'and editing it into other words is not');

-- A shout-out's title is the recipient's name ---------------------------------------------------------------------
select pg_temp.as_platform();
update app.people set full_name = 'Amani Joto' where id = pg_temp.id('dave');
select pg_temp.as_user('carol');
select lives_ok($$insert into k select 'rec', app.recognize(pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Thanks for covering my shift.')$$,
  'a clean shout-out is sent to someone whose name holds a listed term');
select pg_temp.as_platform();
select is((select p.title from app.feed_posts p join app.recognitions r on r.feed_post_id = p.id where r.id = (select id from k where key = 'rec')),
  'Amani Joto', 'its post carries the name XOS adds');
select pg_temp.as_user('carol');
select throws_ok($$select app.recognize(pg_temp.id('org_a'), pg_temp.id('dave@org_a'), 'Thanks, you sudaca.')$$,
  'XR001', null, 'the shout-out the sender types is still checked');
select pg_temp.as_platform();
select throws_ok($$update app.feed_posts set body = 'What a towelhead.'
  where id = (select r.feed_post_id from app.recognitions r where r.id = (select id from k where key = 'rec'))$$,
  'XR001', null, 'and so is an edit to its body');

select * from finish();
rollback;
