-- pgTAP: migration 2200, one-tap actions (A127, ADR 0106; Section 11.10 rule 5). An email's action link works once,
-- for its recipient only, in the app it was sent for, until it expires, and acts through app.act_on_notification so
-- every rule still decides; a forged or replaced link does nothing. A shift and an offer are accepted or declined and a
-- message answered where the notification arrives, and wait on the person until they answer; an offer reaches its
-- applicant; an external party clears and snoozes their own notifications, but not one from an org they do not work with.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(72);

create temporary table k (key text primary key, id uuid, token text);
grant select, insert, update on k to public;

create function pg_temp.note(p_person text, p_kind text, p_subject text) returns uuid
language sql as $$
  select n.id from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = p_kind and n.subject_id = pg_temp.id(p_subject)
  order by n.created_at desc, n.id desc limit 1
$$;
create function pg_temp.email_delivery(p_notification uuid) returns uuid
language sql as $$
  select d.id from app.notification_deliveries d where d.notification_id = p_notification and d.channel = 'Email'
$$;
create function pg_temp.mint(p_key text, p_notification uuid) returns integer
language plpgsql as $$
declare
  v record;
  v_count integer := 0;
begin
  for v in select * from app.mint_notification_action_tokens(pg_temp.email_delivery(p_notification)) loop
    insert into k values (p_key || '_' || v.action, null, v.token)
    on conflict (key) do update set token = excluded.token;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
create function pg_temp.token(p_key text) returns text language sql as $$ select token from k where key = p_key $$;

-- 1. A timesheet approval request, by email -----------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
           values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-05', '2027-07-11') returning id)
  insert into k select 'ts', id from x;
select app.submit_timesheet((select id from k where key = 'ts'), 'Week of the load-in.');
select pg_temp.as_platform();
insert into world select 'ts', id from k where key = 'ts';
insert into world select 'n_carol', pg_temp.note('carol', 'approval.requested', 'ts');

select isnt(pg_temp.email_delivery(pg_temp.id('n_carol')), null, 'the approval request goes to the Manager by email');
select is(pg_temp.mint('carol', pg_temp.id('n_carol')), 2, 'its email carries two action links');
select set_eq($$select action, audience from private.notification_action_tokens
                where notification_id = (select id from world where key = 'n_carol')$$,
  $$values ('approve', 'Atlas'), ('reject', 'Atlas')$$, 'approve and reject, both confirmed in Atlas');
select ok(pg_temp.token('carol_approve') ~ '^xact_[0-9a-f]{48}\.[0-9a-f]{32}$', 'a token is a nonce and its signature');
select is((select count(*)::integer from private.notification_action_tokens t
           where t.token_hash = extensions.digest(pg_temp.token('carol_approve'), 'sha256')), 1,
  'only the SHA-256 of the token is stored');
select is((select count(*)::integer from private.notification_action_tokens t
           where encode(t.token_hash, 'escape') like '%xact_%'), 0, 'never the token itself');

-- Opening the link reads; it never acts.
select pg_temp.as_user('carol');
select is((select link_state || ' ' || action from app.read_notification_action(pg_temp.token('carol_approve'), 'Atlas')),
  'ready approve', 'the recipient reads what the link does');
select is((select title from app.read_notification_action(pg_temp.token('carol_approve'), 'Atlas')),
  (select message_args ->> 'title' from app.notifications where id = pg_temp.id('n_carol')), 'with the item''s title');
select pg_temp.as_platform();
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts')), 'Submitted',
  'reading the link left the timesheet as it was');

-- The wrong person.
select pg_temp.as_user('bob');
select is((select link_state from app.read_notification_action(pg_temp.token('carol_approve'), 'Atlas')), 'not_yours',
  'another approver signed in learns only that the link is not theirs');
select is((select action from app.read_notification_action(pg_temp.token('carol_approve'), 'Atlas')), null,
  'and nothing about what it does');
select throws_ok(format($$select app.use_notification_action(%L, 'Atlas')$$, pg_temp.token('carol_approve')), 'XR001',
  'notification_action_not_yours: This link was sent to someone else. Sign in as the person it was sent to.',
  'the link refuses the wrong person');

-- Forged links.
select pg_temp.as_user('carol');
select is((select link_state from app.read_notification_action(
  regexp_replace(pg_temp.token('carol_approve'), '\.[0-9a-f]{32}$', '.' || repeat('0', 32)), 'Atlas')), 'invalid',
  'a token with a forged signature is unknown');
select is((select link_state from app.read_notification_action('xact_nonsense', 'Atlas')), 'invalid', 'so is a malformed one');
select throws_ok($$select app.use_notification_action('xact_nonsense', 'Atlas')$$, 'XR001',
  'notification_action_invalid: This link does not work. Open the item from your Inbox.', 'and neither acts');

-- A rejection needs its reason; a rule that refuses leaves the link unused.
select throws_ok(format($$select app.use_notification_action(%L, 'Atlas')$$, pg_temp.token('carol_reject')), 'XR001',
  'notification_action_reason: Say why when you reject.', 'a rejection through the link asks for the reason');

-- A member's link is confirmed in Atlas, which applies the org's security settings; Gateway's host does nothing with it.
select is((select concat_ws(' ', link_state, action, title, audience)
           from app.read_notification_action(pg_temp.token('carol_approve'), 'Gateway')), 'elsewhere Atlas',
  'opened in Gateway, a member''s link says only that it opens in Atlas');
select throws_ok(format($$select app.use_notification_action(%L, 'Gateway')$$, pg_temp.token('carol_approve')), 'XR001',
  'notification_action_elsewhere: This link opens in Atlas. Use the button in the email.', 'and does not act there');

-- Works once.
select lives_ok(format($$select app.use_notification_action(%L, 'Atlas')$$, pg_temp.token('carol_approve')),
  'the Manager approves through the link');
select pg_temp.as_platform();
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts')), 'Approved',
  'the timesheet is approved, through app.decide_timesheet');
select is((select approved_by from app.timesheet_approvals where timesheet_id = pg_temp.id('ts')), pg_temp.id('carol'),
  'as the Manager''s own approval');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.use_notification_action(%L, 'Atlas')$$, pg_temp.token('carol_approve')), 'XR001',
  'notification_action_used: This was already handled.', 'the link works once');
select throws_ok(format($$select app.use_notification_action(%L, 'Atlas', 'Changed my mind.')$$, pg_temp.token('carol_reject')),
  'XR001', 'notification_action_used: This was already handled.', 'and using it used the reject link too');
select is((select link_state from app.read_notification_action(pg_temp.token('carol_reject'), 'Atlas')), 'used',
  'the confirm page says it was handled');

-- 2. Expiry, re-minting, and who may mint ---------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
           values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-12', '2027-07-18') returning id)
  insert into k select 'ts2', id from x;
select app.submit_timesheet((select id from k where key = 'ts2'), 'Strike week.');
select pg_temp.as_platform();
insert into world select 'ts2', id from k where key = 'ts2';
insert into world select 'n_bob', pg_temp.note('bob', 'approval.requested', 'ts2');
select pg_temp.mint('bob1', pg_temp.id('n_bob'));
select pg_temp.mint('bob2', pg_temp.id('n_bob'));
select pg_temp.as_user('bob');
select is((select link_state from app.read_notification_action(pg_temp.token('bob1_approve'), 'Atlas')), 'invalid',
  'a retried delivery replaces the links of the attempt before');
select pg_temp.as_platform();
update private.notification_action_tokens set created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
where token_hash = extensions.digest(pg_temp.token('bob2_approve'), 'sha256');
select pg_temp.as_user('bob');
select is((select link_state from app.read_notification_action(pg_temp.token('bob2_approve'), 'Atlas')), 'expired',
  'a link past its 7 days says so');
select throws_ok(format($$select app.use_notification_action(%L, 'Atlas')$$, pg_temp.token('bob2_approve')), 'XR001',
  'notification_action_expired: This link has expired. Open the item from your Inbox.', 'and no longer acts');
select throws_ok(format($$select * from app.mint_notification_action_tokens(%L)$$, pg_temp.email_delivery(pg_temp.id('n_bob'))),
  '42501', null, 'only the email sender (service role) mints links');
select pg_temp.as_platform();
select is(pg_temp.mint('bob3', pg_temp.id('n_carol')), 0, 'a decided request''s email offers no action');

-- 3. A shift, from the notification ---------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', now() + interval '2 days', now() + interval '2 days 8 hours',
    'America/New_York') returning id) insert into k select 'sh1', id from x;
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', now() + interval '4 days', now() + interval '4 days 8 hours',
    'America/New_York') returning id) insert into k select 'sh2', id from x;
select app.publish_shifts(array[(select id from k where key = 'sh1'), (select id from k where key = 'sh2')]);
select pg_temp.as_platform();
insert into world select key, id from k where key in ('sh1', 'sh2');
select is((select message_args ->> 'shiftState' from app.notifications where id = pg_temp.note('frank', 'shift.assigned', 'sh1')),
  'Published', 'a shift notice says the shift waits on its worker');
select set_eq(format($$select action, audience from private.notification_link_actions(%L)$$, pg_temp.note('frank', 'shift.assigned', 'sh1')),
  $$values ('accept', 'Atlas')$$, 'so its email offers Accept, confirmed in Atlas');
select pg_temp.as_user('frank');
select ok(pg_temp.note('frank', 'shift.assigned', 'sh1') in (select app.my_notifications_awaiting_answer()),
  'and it waits on the worker''s answer, so it is no For Your Information item');

select pg_temp.as_user('carol');
select throws_ok(format($$select app.act_on_notification(%L, 'accept')$$, pg_temp.note('frank', 'shift.assigned', 'sh1')),
  '42501', null, 'nobody acts on someone else''s notification');
select pg_temp.as_user('frank');
select lives_ok(format($$select app.act_on_notification(%L, 'accept')$$, pg_temp.note('frank', 'shift.assigned', 'sh1')),
  'the worker accepts the shift from the notification');
select lives_ok(format($$select app.act_on_notification(%L, 'decline', 'Out of town that week.')$$,
  pg_temp.note('frank', 'shift.assigned', 'sh2')), 'and declines the other with a reason');
select pg_temp.as_platform();
select is((select shift_state::text from app.shifts where id = pg_temp.id('sh1')), 'Accepted', 'the first shift is accepted');
select is((select shift_state::text from app.shifts where id = pg_temp.id('sh2')), 'Draft',
  'the declined shift goes back to Draft for the scheduler');
select is((select t.reason from app.shift_state_transitions t where t.shift_id = pg_temp.id('sh2') and t.to_state = 'Draft' and t.from_state = 'Published'),
  'Declined by the worker: Out of town that week.', 'with the reason in its ledger');
select pg_temp.as_user('frank');
select throws_ok(format($$select app.decline_shift(%L)$$, pg_temp.id('sh1')), 'XR001', null,
  'an accepted shift is no longer declined');

-- 3b. Nobody else declines an engaged worker's shift or an open one ---------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with x as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', now() + interval '6 days', now() + interval '6 days 8 hours',
    'America/New_York') returning id) insert into k select 'sh_eng', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '7 days', now() + interval '7 days 8 hours',
    'America/New_York') returning id) insert into k select 'sh_open', id from x;
select app.publish_shifts(array[(select id from k where key = 'sh_eng'), (select id from k where key = 'sh_open')]);
select pg_temp.as_platform();
insert into world select key, id from k where key in ('sh_eng', 'sh_open');
insert into world select 'n_sh_eng', pg_temp.note('ivy', 'shift.assigned', 'sh_eng');
select pg_temp.as_user('ivy');
select ok(pg_temp.id('n_sh_eng') in (select app.my_notifications_awaiting_answer()),
  'the engaged worker''s published shift waits on their answer');
select pg_temp.as_user('frank');
select throws_ok(format($$select app.decline_shift(%L, 'Not mine.')$$, pg_temp.id('sh_eng')), '42501', null,
  'a member of the org does not decline an engaged worker''s shift');
select throws_ok(format($$select app.decline_shift(%L, 'Not mine.')$$, pg_temp.id('sh_open')), '42501', null,
  'nor an open shift nobody holds');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.decline_shift(%L, 'Not mine.')$$, pg_temp.id('sh_eng')), '42501', null,
  'nor does a member of another org');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.decline_shift(%L, 'Not mine.')$$, pg_temp.id('sh_open')), '42501', null,
  'an engaged worker does not decline an open shift either');
select pg_temp.as_platform();
select is((select array_agg(shift_state::text order by starts_at) from app.shifts where id in (pg_temp.id('sh_eng'), pg_temp.id('sh_open'))),
  array['Published', 'Published'], 'both shifts are still published');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.decline_shift(%L, 'Booked elsewhere.')$$, pg_temp.id('sh_eng')),
  'the engaged worker declines their own shift');
select pg_temp.as_platform();
select is((select shift_state::text from app.shifts where id = pg_temp.id('sh_eng')), 'Draft',
  'and it goes back to Draft for the scheduler');
select pg_temp.as_user('ivy');
select ok(pg_temp.id('n_sh_eng') not in (select app.my_notifications_awaiting_answer()),
  'answered from the shift itself, its notice no longer waits on them');

-- 4. A message, answered from the notification ---------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into k select 'conv', app.start_direct_conversation(pg_temp.id('org_a'), pg_temp.id('frank@org_a'));
select app.send_chat_message((select id from k where key = 'conv'), 'Can you cover Friday?');
select pg_temp.as_platform();
insert into world select 'n_msg', n.id from app.notifications n
  where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'message.received' order by n.created_at desc limit 1;
select pg_temp.as_user('frank');
select throws_ok(format($$select app.act_on_notification(%L, 'reply', '  ')$$, pg_temp.id('n_msg')), 'XR001',
  'notification_reply_empty: Write a reply first.', 'a reply needs words');
select lives_ok(format($$select app.act_on_notification(%L, 'reply', 'Yes, I can.')$$, pg_temp.id('n_msg')),
  'the worker replies from the notification');
select pg_temp.as_platform();
select is((select body from app.chat_messages where conversation_id = (select id from k where key = 'conv')
           order by created_at desc, id desc limit 1), 'Yes, I can.', 'the reply lands in the conversation');

-- 5. An offer reaches its applicant, who accepts it from the notification -------------------------------------------------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into k select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values ((select id from k where key = 'opp'), pg_temp.id('quinn')),
  ((select id from k where key = 'opp'), pg_temp.id('ivy'));
select app.transition_opportunity((select id from k where key = 'opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity((select id from k where key = 'opp'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('quinn');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
  values ((select id from k where key = 'opp'), pg_temp.id('quinn'), true) returning id) insert into k select 'app_q', id from a;
select pg_temp.as_user('ivy');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
  values ((select id from k where key = 'opp'), pg_temp.id('ivy'), true) returning id) insert into k select 'app_i', id from a;
select pg_temp.as_user('alice');
select app.transition_application((select id from k where key = 'app_q'), 'Submitted', 'In Review', 'Screening.');
select app.transition_application((select id from k where key = 'app_i'), 'Submitted', 'In Review', 'Screening.');
select pg_temp.as_platform();
select ok(pg_temp.id('org_a') not in (select private.party_org_ids(pg_temp.id('quinn'))),
  'before an offer, the applicant does not work with the org');
with n as (insert into app.notifications (org_id, recipient_person_id, kind, message_args)
  values (pg_temp.id('org_a'), pg_temp.id('quinn'), 'invoice.paid', jsonb_build_object('title', 'INV-0999')) returning id)
  insert into world select 'n_stray', id from n;
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.act_on_notification(%L, 'done')$$, pg_temp.id('n_stray')), '42501', null,
  'a notification from an org the person no longer works with is not theirs to mark Done');
select pg_temp.as_user('carol');
insert into k select 'offer', app.send_offer((select id from k where key = 'app_q'), 'Day', 90000, 'USD', '2027-06-01', '2027-06-03',
  'Welcome aboard.', null);
insert into k select 'offer_i', app.send_offer((select id from k where key = 'app_i'), 'Day', 85000, 'USD', '2027-06-01', '2027-06-03',
  'Hope you can join us.', null);
select pg_temp.as_platform();
insert into world select 'offer', id from k where key = 'offer';
insert into world select 'n_offer', pg_temp.note('quinn', 'offer.sent', 'offer');
insert into world select 'offer_i', id from k where key = 'offer_i';
insert into world select 'n_offer_i', pg_temp.note('ivy', 'offer.sent', 'offer_i');
select is((select message_args ->> 'title' from app.notifications where id = pg_temp.id('n_offer')), 'Summer Series Riggers',
  'the applicant is told about the offer');
select set_eq(format($$select channel::text from app.notification_deliveries where notification_id = %L$$, pg_temp.id('n_offer')),
  $$values ('Email'), ('Push')$$, 'by email and push, while the offer waits on them');
select set_eq(format($$select action, audience from private.notification_link_actions(%L)$$, pg_temp.id('n_offer')),
  $$values ('accept', 'Gateway')$$, 'its email offers Accept, confirmed in Gateway');
select pg_temp.mint('quinn', pg_temp.id('n_offer'));
select pg_temp.as_user('quinn');
select is((select concat_ws(' ', link_state, action, title, audience)
           from app.read_notification_action(pg_temp.token('quinn_accept'), 'Atlas')), 'elsewhere Gateway',
  'opened in Atlas, the applicant''s link says only that it opens in Gateway');
select is((select link_state || ' ' || action from app.read_notification_action(pg_temp.token('quinn_accept'), 'Gateway')),
  'ready accept', 'and is ready in Gateway');
select ok(pg_temp.id('n_offer') in (select app.my_notifications_awaiting_answer()), 'the offer waits on the applicant');
select pg_temp.as_user('quinn');
select lives_ok(format($$select app.act_on_notification(%L, 'accept')$$, pg_temp.id('n_offer')),
  'the applicant accepts the offer from the notification');
select pg_temp.as_platform();
select is((select offer_state::text from app.offers where id = pg_temp.id('offer')), 'Accepted', 'the offer is accepted');
select ok(pg_temp.id('org_a') not in (select private.party_org_ids(pg_temp.id('quinn'))),
  'once answered, the offer no longer makes the applicant someone the org works with');
select pg_temp.as_user('quinn');
-- notifications.act reads the notification back under the caller's row level security after acting (the push path).
select is((select (archived_at is not null)::text from app.notifications where id = pg_temp.id('n_offer')), 'true',
  'the applicant still reads their offer notice after accepting it, now handled');
select is((select count(*)::integer from app.notifications where id = pg_temp.id('n_stray')), 0,
  'but not the org''s other notices');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.act_on_notification(%L, 'decline', 'Not for me.')$$, pg_temp.id('n_offer_i')), '42501', null,
  'nobody declines another applicant''s offer from their notification');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.act_on_notification(%L, 'decline', 'Booked that week.')$$, pg_temp.id('n_offer_i')),
  'the other applicant declines their offer from the notification');
select pg_temp.as_platform();
select is((select offer_state::text from app.offers where id = pg_temp.id('offer_i')), 'Declined', 'the offer is declined');
select pg_temp.as_user('ivy');
select is((select count(*)::integer from app.notifications where id = pg_temp.id('n_offer_i')), 1,
  'the applicant still reads their offer notice after declining it');

-- 6. An external party clears and snoozes their own notifications; approving stays a member's ---------------------------
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.act_on_notification(%L, 'approve')$$, pg_temp.id('n_carol')), '42501', null,
  'nobody approves from another person''s notification');
select pg_temp.as_platform();
insert into world select 'n_ivy', private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'invoice.paid', null, null, null,
  jsonb_build_object('title', 'INV-1001', 'orgName', 'Northwind Live'));
insert into world select 'n_ivy2', private.notify(pg_temp.id('org_a'), pg_temp.id('ivy'), 'invoice.scheduled', null, null, null,
  jsonb_build_object('title', 'INV-1002', 'orgName', 'Northwind Live'));
select pg_temp.as_user('ivy');
select lives_ok(format($$insert into app.inbox_snoozes (notification_id, notification_created_at, snoozed_until)
  select id, created_at, now() + interval '1 day' from app.notifications where id = %L$$, pg_temp.id('n_ivy')),
  'an external party snoozes a notification from an org they are no member of');
select lives_ok(format($$select app.act_on_notification(%L, 'done')$$, pg_temp.id('n_ivy2')), 'and marks another Done');
select is((select count(*)::integer from app.inbox_items where id in (pg_temp.id('n_ivy'), pg_temp.id('n_ivy2'))), 0,
  'both leave their For Your Information list');

select * from finish();
rollback;
