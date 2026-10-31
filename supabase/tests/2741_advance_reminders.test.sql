-- pgTAP: migration 2741 (R11), automatic advance reminders. 'due' goes once, days_before ahead; 'overdue:k' every N days
-- after, the highest k reached, at most 5; a project override and an org lock turn them off; a second run sends nothing.
-- They reach the person, the account's Owner and the Advancing Lead, never an Account Member who is not assigned
-- (owner decision 6). A manual reminder needs advancing.packet.send and goes at most once a day. Both cron jobs are
-- scheduled. Project facts reminders go only while an offering is on and its fact is missing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.reminded(p_who text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = 'advance_packet.reminder' and n.subject_id = pg_temp.id('pkt')
$$;

create function pg_temp.ledger(p_reminder text) returns integer
language sql as $$
  select count(*)::int from private.advance_reminders_sent s
  where s.advance_recipient_id in (pg_temp.id('rcp_v'), pg_temp.id('rcp_art')) and s.reminder = p_reminder
$$;

select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with p as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Production Advance', now() + interval '2 days') returning id)
insert into world select 'pkt', id from p;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 1, 'Power') returning id)
insert into world select 's_power', id from s;
with r as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id)
insert into world select 'rcp_v', id from r;
with r as (insert into app.advance_recipients (advance_packet_id, person_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('art'), pg_temp.id('eng_art_a')) returning id)
insert into world select 'rcp_art', id from r;
select app.send_advance_packet(pg_temp.id('pkt'));
select app.set_setting(pg_temp.id('org_a'), 'advancing.reminders', 'Project', pg_temp.id('prj_a'), p_value_boolean => false);
select pg_temp.as_platform();

-- Who is reminded --------------------------------------------------------------------------------------------------------------
select set_eq(format($$select private.advance_reminder_recipients(%L)$$, pg_temp.id('rcp_v')),
  format($$values (%L::uuid), (%L::uuid)$$, pg_temp.id('victor'), pg_temp.id('pia')),
  'a counterparty''s reminder reaches its Account Owner and its Advancing Lead');
select set_eq(format($$select private.advance_reminder_recipients(%L)$$, pg_temp.id('rcp_art')),
  format($$values (%L::uuid)$$, pg_temp.id('art')), 'a person''s reaches the person');

-- Due ---------------------------------------------------------------------------------------------------------------------------
select is(private.send_advance_reminders(), 0, 'a project override turns reminders off');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.reminders', 'Project', pg_temp.id('prj_a'), p_value_boolean => true);
select pg_temp.as_platform();
select is(private.send_advance_reminders(), 3, 'two days before the due date, the due reminder goes out');
select is(pg_temp.reminded('victor'), 1, 'to the Owner');
select is(pg_temp.reminded('pia'), 1, 'to the Advancing Lead');
select is(pg_temp.reminded('art'), 1, 'to the person');
select is(pg_temp.reminded('mo'), 0, 'not to an Account Member assigned only as Member');
select is(pg_temp.reminded('kai'), 0, 'nor to an unassigned Account Member');
select is(pg_temp.reminded('fiona'), 0, 'nor to Account Finance');
select is((select message_args ->> 'reminder' from app.notifications where kind = 'advance_packet.reminder'
  and recipient_person_id = pg_temp.id('victor')), 'due', 'it says the packet is coming due');
select is((select message_args ->> 'outstanding' from app.notifications where kind = 'advance_packet.reminder'
  and recipient_person_id = pg_temp.id('victor')), '1', 'with what is outstanding');
select ok((select message_args ->> 'gatewayPath' like '/work/engagements/%/advance' from app.notifications
  where kind = 'advance_packet.reminder' and recipient_person_id = pg_temp.id('victor')), 'and opens the engagement''s Advance tab');
select is(private.send_advance_reminders(), 0, 'a second run sends nothing');
update app.advance_packets set due_at = now() + interval '2 days 2 minutes' where id = pg_temp.id('pkt');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.reminder_days_before', 'Project', pg_temp.id('prj_a'), p_value_integer => 1);
select pg_temp.as_platform();
select is(private.send_advance_reminders(), 0, 'with advancing.reminder_days_before at 1, two days ahead is too early');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.reminder_days_before', 'Project', pg_temp.id('prj_a'), p_value_integer => 3);
select pg_temp.as_platform();
select is(private.send_advance_reminders(), 3, 'at 3 the moved due date is reminded');

-- An org lock --------------------------------------------------------------------------------------------------------------------
update app.advance_packets set due_at = now() + interval '1 day' where id = pg_temp.id('pkt');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.reminders', 'Organization', null, p_value_boolean => false, p_locked => true);
select pg_temp.as_platform();
select is(private.send_advance_reminders(), 0, 'an org lock turns them off over the project''s value');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.reminders', 'Organization', null, p_value_boolean => true);
select pg_temp.as_platform();

-- Overdue -------------------------------------------------------------------------------------------------------------------------
update app.advance_packets set due_at = now() - interval '5 days' where id = pg_temp.id('pkt');
select is(private.send_advance_reminders(), 3, 'five days late, every two days, the second overdue reminder goes out');
select is(pg_temp.ledger('overdue:2'), 3, 'as overdue:2');
select is(pg_temp.ledger('overdue:1'), 0, 'skipping the one already passed');
select is(private.send_advance_reminders(), 0, 'and only once');
update app.advance_packets set due_at = now() - interval '40 days' where id = pg_temp.id('pkt');
select is(private.send_advance_reminders(), 3, 'long overdue, a reminder still goes');
select is(pg_temp.ledger('overdue:5'), 3, 'but never past the fifth');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.overdue_reminder_every_days', 'Project', pg_temp.id('prj_a'), p_value_integer => 0);
select pg_temp.as_platform();
update app.advance_packets set due_at = now() - interval '6 days' where id = pg_temp.id('pkt');
select is(private.send_advance_reminders(), 0, 'every 0 days sends no overdue reminder');

-- Nothing outstanding --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'advancing.overdue_reminder_every_days', 'Project', pg_temp.id('prj_a'), p_value_integer => 2);
select pg_temp.as_platform();
update app.advance_packets set due_at = now() + interval '2 days' + interval '1 minute' where id = pg_temp.id('pkt');
insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
values (pg_temp.id('s_power'), pg_temp.id('rcp_art'), 'One 32 A feed.');
select is(private.send_advance_reminders(), 2, 'a recipient whose sections await review is not reminded');

-- By hand --------------------------------------------------------------------------------------------------------------------------
select pg_temp.producer('watcher', 'advancing.packet.read');
select pg_temp.as_user('watcher');
select throws_ok(format($$select * from app.send_advance_reminder_now(%L, array[%L]::uuid[])$$, pg_temp.id('pkt'), pg_temp.id('rcp_v')),
  '42501', null, 'reminding by hand needs advancing.packet.send');
select pg_temp.as_user('alice');
select throws_ok(format($$select * from app.send_advance_reminder_now(%L, array[]::uuid[])$$, pg_temp.id('pkt')),
  'XR001', null, 'and 1 to 200 recipients');
select results_eq(format($$select sent, skipped from app.send_advance_reminder_now(%L, array[%L, %L]::uuid[])$$,
    pg_temp.id('pkt'), pg_temp.id('rcp_v'), pg_temp.id('rcp_art')),
  $$values (1, 1)$$, 'a recipient with something outstanding is reminded, one with nothing outstanding skipped');
select results_eq(format($$select sent, skipped from app.send_advance_reminder_now(%L, array[%L]::uuid[])$$, pg_temp.id('pkt'), pg_temp.id('rcp_v')),
  $$values (0, 1)$$, 'at most once a day');
select pg_temp.as_platform();
select is((select count(*)::int from private.advance_reminders_sent where reminder = 'manual'), 2, 'one manual ledger row per person reached');

-- Jobs -----------------------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from cron.job where jobname = 'xos_send_advance_reminders' and schedule = '23 * * * *'),
  'packet reminders run hourly');
select ok(exists (select 1 from cron.job where jobname = 'xos_send_roster_fact_reminders' and schedule = '27 * * * *'),
  'and project facts reminders');

-- Project facts --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select app.update_roster_entry(pg_temp.id('e_una'), '9000.50.02', now() + interval '2 days', now() + interval '2 days 2 hours', 'America/New_York');
select app.submit_roster(pg_temp.id('eng_vendor_a'));
select pg_temp.as_user('una');
select app.respond_roster_entry(pg_temp.id('e_una'), 'Accepted');
select pg_temp.as_user('carol');
select app.review_roster_entry(pg_temp.id('e_una'), 'Accepted');
select pg_temp.as_platform();
select is(private.send_roster_fact_reminders(), 1, 'an accepted entry arriving in two days with facts missing is reminded');
select is((select count(*)::int from app.notifications where kind = 'roster_entry.facts_requested' and subject_id = pg_temp.id('e_una')
  and recipient_person_id = pg_temp.id('una')), 2, 'the person is asked again, after the notice of acceptance (2742)');
select is((select threshold_days::int from private.roster_fact_reminders_sent where roster_entry_id = pg_temp.id('e_una')), 3,
  'at the days_before threshold');
select is(private.send_roster_fact_reminders(), 0, 'once');
delete from private.roster_fact_reminders_sent;
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.' || o, 'Organization', null, 'not-offered')
from unnest(array['travel', 'uniforms', 'parking']) o;
select pg_temp.as_platform();
select is(private.send_roster_fact_reminders(), 0, 'with the offerings off nothing is asked for');

select * from finish();
rollback;
