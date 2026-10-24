-- pgTAP: migration 1461 (A89, RRR-134, A65-008). A marketplace match reaches a person the posting org has no
-- relationship with, exactly while the listing is open to them; anything else to that person still reaches nobody
-- (invariant 3). A person without a membership keeps quiet hours of their own: a push waits them out at queue time and
-- at claim time, email does not.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(20);

-- An Invited listing of org_a for nina, who works with no org.
select pg_temp.as_user('carol');
insert into app.opportunities (project_id, role_type, title, visibility, rate_type, deadline_at, starts_on, ends_on)
values (pg_temp.id('prj_a'), 'Vendor', 'Summer Series Delay Towers', 'Invited', 'Bid', now() + interval '20 days', '2027-06-01', '2027-06-03')
returning id as v_opp \gset
insert into world values ('opp', :'v_opp');
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('nina'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_platform();

create function pg_temp.match(p_person text) returns uuid
language sql as $$
  select private.notify(pg_temp.id('org_a'), pg_temp.id(p_person), 'opportunity.matched', 'opportunities', pg_temp.id('opp'),
    pg_temp.id('prj_a'), jsonb_build_object('title', 'Summer Series Delay Towers', 'count', 1, 'gatewayPath', '/explore/alerts'));
$$;

create function pg_temp.channels(p_notification uuid) returns text
language sql as $$
  select coalesce(string_agg(d.channel::text || ':' || d.message_status::text, ',' order by d.channel), '')
  from app.notification_deliveries d where d.notification_id = p_notification;
$$;

-- 1. The marketplace relationship.
select pg_temp.match('nina') as v_n1 \gset
select isnt(:'v_n1'::uuid, null, 'a match about a listing open to nina reaches her though she works with no org');
select is(pg_temp.channels(:'v_n1'), 'Email:Queued,Push:Queued', 'by email and push, as her own preferences allow; no text');
select is(private.notify(pg_temp.id('org_a'), pg_temp.id('nina'), 'invoice.paid', 'invoices', pg_temp.id('opp'), null, '{}'),
  null, 'any other kind still reaches nobody outside the org (invariant 3)');
select is(pg_temp.match('quinn'), null, 'a match about a listing not open to the person reaches nobody: visibility is never widened');

select pg_temp.claims('nina');
select ok(private.is_my_notification(:'v_n1'), 'nina may open the match');
select pg_temp.as_user('nina');
select is((select count(*)::integer from app.notifications where id = :'v_n1'), 1, 'and reads it in her inbox');
select pg_temp.as_platform();

-- 2. A person's own quiet hours, around the current time in Honolulu.
select pg_temp.as_user('nina');
select throws_ok($$select app.set_my_quiet_hours('Mars/Olympus', '22:00', '07:00')$$, 'XR001', null, 'an unknown time zone is refused');
select lives_ok($$select app.set_my_quiet_hours('Pacific/Honolulu',
  ((now() at time zone 'Pacific/Honolulu') - interval '1 hour')::time, ((now() at time zone 'Pacific/Honolulu') + interval '1 hour')::time)$$,
  'nina sets quiet hours around now in her time zone');
select pg_temp.as_platform();
select is((select count(*)::integer from app.person_notification_settings where person_id = pg_temp.id('nina')), 1, 'kept in one row');
select isnt(private.person_quiet_until(pg_temp.id('nina'), now()), null, 'now falls inside them');
select pg_temp.match('nina') as v_n2 \gset
select is(pg_temp.channels(:'v_n2'), 'Email:Queued,Push:Deferred', 'the push waits out her quiet hours; the email does not');
select ok((select d.deliver_after > now() from app.notification_deliveries d where d.notification_id = :'v_n2' and d.channel = 'Push'),
  'until they end');

-- Quiet hours that begin after the push was queued hold it at claim time.
select pg_temp.as_user('nina');
select app.set_my_quiet_hours('Pacific/Honolulu', null, null);
select pg_temp.as_platform();
select pg_temp.match('nina') as v_n3 \gset
select is(pg_temp.channels(:'v_n3'), 'Email:Queued,Push:Queued', 'without quiet hours both go at once');
select pg_temp.as_user('nina');
select app.set_my_quiet_hours('Pacific/Honolulu',
  ((now() at time zone 'Pacific/Honolulu') - interval '1 hour')::time, ((now() at time zone 'Pacific/Honolulu') + interval '1 hour')::time);
select pg_temp.as_platform();
select is((select count(*)::integer from app.claim_notification_deliveries('Push', 500) c
           where c.delivery_id in (select d.id from app.notification_deliveries d where d.notification_id = :'v_n3')), 0,
  'a push claimed during quiet hours is not handed to the sender');
select is(pg_temp.channels(:'v_n3'), 'Email:Queued,Push:Deferred', 'it waits again');

-- External parties keep their quiet hours too: ivy works with org_a through an engagement.
select pg_temp.as_user('ivy');
select app.set_my_quiet_hours('Pacific/Honolulu',
  ((now() at time zone 'Pacific/Honolulu') - interval '1 hour')::time, ((now() at time zone 'Pacific/Honolulu') + interval '1 hour')::time);
select pg_temp.as_platform();
select is(pg_temp.channels(private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'invoice.paid', 'invoices', pg_temp.id('opp'), null, '{}')),
  'Email:Queued,Push:Deferred', 'an external party''s push waits out their own quiet hours');

-- 3. Preferences: nina turns Push off for Opportunities.
select pg_temp.as_user('nina');
insert into app.person_notification_preferences (person_id, category_code, channel, enabled) values (pg_temp.id('nina'), 'opportunities', 'Push', false);
select pg_temp.as_platform();
select is(pg_temp.channels(pg_temp.match('nina')), 'Email:Queued', 'a channel turned off for the category gets no delivery');

-- 4. The listing closes: the match leaves her inbox and its deliveries are suppressed.
select pg_temp.as_user('carol');
select app.transition_opportunity(pg_temp.id('opp'), 'Published', 'Closed', 'Filled elsewhere.');
select pg_temp.as_platform();
select is((select count(*)::integer from app.claim_notification_deliveries('Email', 500) c
           where c.delivery_id in (select d.id from app.notification_deliveries d where d.notification_id = :'v_n1')), 0,
  'the queued email is not sent');
select is((select d.last_error from app.notification_deliveries d where d.notification_id = :'v_n1' and d.channel = 'Email'),
  'The listing is no longer open to the recipient.', 'it is suppressed with the reason');
select pg_temp.as_user('nina');
select is((select count(*)::integer from app.notifications where id = :'v_n1'), 0, 'and the match leaves her inbox');

select * from finish();
rollback;
