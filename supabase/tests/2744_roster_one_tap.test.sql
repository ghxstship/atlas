-- pgTAP: migration 2744 (R11, A127), one-tap answers to a roster invitation. While the person has not answered, the
-- email of roster_entry.invited carries an Accept link confirmed in Gateway and the invitation waits on them (Gateway's
-- For Your Information leaves it out); accepting or declining through app.act_on_notification answers the entry through
-- R4's app.respond_roster_entry. Once answered, the email offers nothing more; someone else cannot act on it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.invite_of(p_who text, p_entry text) returns uuid
language sql as $$
  select n.id from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = 'roster_entry.invited' and n.subject_id = pg_temp.id(p_entry)
  order by n.created_at desc limit 1
$$;

select pg_temp.as_user('victor');
insert into world select 'e_pia', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('pia'), '9000.50.02');
select pg_temp.as_platform();
insert into world select 'n_una', pg_temp.invite_of('una', 'e_una');
insert into world select 'n_pia', pg_temp.invite_of('pia', 'e_pia');
insert into world select 'n_kai', pg_temp.invite_of('kai', 'e_kai');

select isnt(pg_temp.id('n_una'), null, 'the person put on the roster was told');
select results_eq(format($$select action, audience from private.notification_link_actions(%L)$$, pg_temp.id('n_una')),
  $$values ('accept'::text, 'Gateway'::text)$$, 'an unanswered invitation''s email carries Accept, confirmed in Gateway');
select is((select count(*)::int from private.notification_link_actions(pg_temp.id('n_kai'))), 0,
  'an invitation already answered carries nothing');

select pg_temp.as_user('una');
select ok(pg_temp.id('n_una') in (select app.my_notifications_awaiting_answer()), 'the invitation waits on the person');
select pg_temp.as_user('kai');
select throws_ok(format($$select app.act_on_notification(%L, 'accept')$$, pg_temp.id('n_una')), '42501', null,
  'someone else cannot answer it');
select pg_temp.as_user('una');
select lives_ok(format($$select app.act_on_notification(%L, 'accept')$$, pg_temp.id('n_una')), 'the person accepts from it');
select pg_temp.as_platform();
select is((select person_response::text from app.engagement_roster_entries where id = pg_temp.id('e_una')), 'Accepted',
  'which answers the roster entry');
select is((select count(*)::int from private.notification_link_actions(pg_temp.id('n_una'))), 0, 'and the email offers nothing more');

select pg_temp.as_user('pia');
select lives_ok(format($$select app.act_on_notification(%L, 'decline')$$, pg_temp.id('n_pia')), 'another person declines from it');
select pg_temp.as_platform();
select is((select person_response::text from app.engagement_roster_entries where id = pg_temp.id('e_pia')), 'Declined',
  'which declines the roster entry');

select * from finish();
rollback;
