-- pgTAP: app.set_thread_subscription follows and mutes threads for the caller only, on threads they can read.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(5);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select pg_temp.as_user('dave');
select app.post_comment('app.projects', pg_temp.id('prj_a'), 'Rigging call at 09:00.');
insert into k select 'thread', id from app.comment_threads;

select pg_temp.as_user('erin');
select lives_ok($$select app.set_thread_subscription((select id from k where key = 'thread'), true)$$, 'a reader follows a thread');
select is((select subscribed from app.thread_subscriptions where person_id = pg_temp.id('erin')), true, 'their own subscription is created');
select app.set_thread_subscription((select id from k where key = 'thread'), false);
select is((select count(*)::integer from app.thread_subscriptions where person_id = pg_temp.id('erin')), 1, 'muting changes the same row');
select pg_temp.as_user('gina');
select throws_ok($$select app.set_thread_subscription((select id from k where key = 'thread'), true)$$, '42501', null,
  'nobody follows a thread they cannot read');
select pg_temp.as_platform();
select is((select subscribed from app.thread_subscriptions where person_id = pg_temp.id('dave')), true, 'the author''s subscription is untouched');

select * from finish();
rollback;
