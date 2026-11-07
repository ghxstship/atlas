-- pgTAP: migration 6168, the appeal rule made true for one person (RRR-248, ADR 0167). With one operator every appeal is
-- still decided: by a fresh, documented re-review, recorded with the reasons, and the person is told the result and that the
-- first decider did it. A named outside reviewer, once appointed, takes every appeal, and ending the appointment gives appeals
-- back. A person the notification queue cannot reach is told by email, and counts as told only once the email has left; an email
-- that fails, or a person with no email, opens a legal queue item with its own clock. The org purge takes the review record.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(96);

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.public_listing(p_key text, p_title text) returns void
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
    currency_code, deadline_at, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', p_title, 'Public', 'Day', 70000, 90000, 'USD', now() + interval '7 days',
    '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id into v;
  insert into world values (p_key, v);
  perform app.transition_opportunity(v, 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(v, 'Pending Approval', 'Published', 'Approved.');
  perform pg_temp.as_platform();
end $$;

-- The whole platform team is one person.
select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('rae', 'rae@reporter.test', 'Rae Stranger');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'The only operator.');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.public_listing('opp_a', 'Summer Series Riggers');
select pg_temp.public_listing('opp_b', 'Summer Series Ushers');
select pg_temp.public_listing('opp_c', 'Summer Series Runners');
select pg_temp.public_listing('opp_d', 'Summer Series Medics');
select pg_temp.public_listing('opp_e', 'Summer Series Cooks');
select pg_temp.public_listing('opp_f', 'Summer Series Drivers');

-- A reporter with no tie to the org, whom the notification queue cannot reach ---------------------------------------------
select pg_temp.as_user('rae');
insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_a'), 'Fraud', 'Asks for a fee to apply.');
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'no_action', app.console_decide_listing(%L, 'No Action', 'No Violation', 'Terms 7.6',
  'The fee is not charged.', 'We found no violation.')$$, pg_temp.id('opp_a')), 'the only operator decides the report');
select pg_temp.as_platform();
select is((select count(*)::int from app.notifications where recipient_person_id = pg_temp.id('rae')), 0, 'the queue cannot reach the reporter');
select ok((select args ->> 'kind' = 'listing_report.decided' and args -> 'values' ->> 'statement' = 'We found no violation.'
  from private.platform_emails where template = 'moderation_notice' and to_email = 'rae@reporter.test'),
  'so the outcome goes to them by email, as the policy promises');
select is((select to_user_id from private.platform_emails where template = 'moderation_notice' and to_email = 'rae@reporter.test'),
  pg_temp.id('rae_user'), 'naming the sign-in it went to, which an address change does not loosen');

select pg_temp.as_user('rae');
select lives_ok(format($$insert into world select 'appeal_same', app.file_moderation_appeal(%L, 'They do charge it.')$$, pg_temp.id('no_action')),
  'the reporter appeals');
select pg_temp.as_platform();
select private.sync_legal_queue_feeds();
select is((select item_state::text from app.legal_queue_items where source_id = pg_temp.id('appeal_same')), 'Received', 'the appeal is in the legal queue');
select is((select rule_code from app.legal_queue_items where source_id = pg_temp.id('appeal_same')), 'moderation_appeal', 'on its own clock');
select pg_temp.as_op('olga');

-- One person keeps the promise -----------------------------------------------------------------------------------------------
select is((app.console_listing_detail(pg_temp.id('opp_a')) #>> '{appeals,0,my_own_decision}')::boolean, true, 'the operator sees it is about their own decision');
select throws_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'Stands.', ' ')$$, pg_temp.id('appeal_same')), 'XR001',
  'moderation_appeal_re_review: Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.',
  'an appeal cannot be decided without a documented re-review');
select throws_ok(format($$select app.console_decide_appeal(%L, 'Upheld', ' ', 'Read it again.')$$, pg_temp.id('appeal_same')), 'XR001',
  'moderation_statement: Write the reasons the appellant receives, in up to 4,000 characters.', 'or without reasons for the person');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'We applied again as a stranger and were not asked for any fee.',
  'Read the appeal, read the listing and the application form as they stand, and applied with a test account. Reporter: Rae Stranger.')$$, pg_temp.id('appeal_same')),
  'and with both, the one operator decides an appeal of their own decision');
select pg_temp.as_platform();
select is((select appeal_state::text from app.moderation_appeals where id = pg_temp.id('appeal_same')), 'Upheld', 'the appeal is decided');
select ok((select same_reviewer and outside_reviewer_id is null and re_review_notes like 'Read the appeal%' and recorded_by = pg_temp.id('olga')
  from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_same')),
  'the re-review is on record, and says the first decider did it');
select is((select told_by from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_same')), 'Email', 'the record says how the person is told');
select is((select told_at from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_same')), null, 'and does not count them told while the email only waits in the outbox');
select ok((select args ->> 'kind' = 'moderation_appeal.decided' and args -> 'values' ->> 'reviewer' = 'same'
    and args -> 'values' ->> 'statement' = 'We applied again as a stranger and were not asked for any fee.'
    and args -> 'values' ->> 'actorName' = 'XOS' and args::text not like '%Read the appeal%'
  from private.platform_emails where template = 'moderation_notice' and to_email = 'rae@reporter.test' and args ->> 'kind' = 'moderation_appeal.decided'),
  'the person gets the result and the reasons, is told who re-reviewed, and never sees the internal notes');
select is((select item_state::text from app.legal_queue_items where source_id = pg_temp.id('appeal_same')), 'Completed', 'the queue item closes with it');
select is((select details ->> 'reviewer' from app.platform_operator_actions where action = 'moderation_appeal.decided' and subject_id = pg_temp.id('appeal_same')), 'same',
  'the console ledger records it');
select hasnt_column('app'::name, 'moderation_appeals'::name, 're_review_notes'::name, 'the appellant''s table holds no internal notes');
select is((select org_id from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_same')), pg_temp.id('org_a'),
  'the record carries its org, so the org purge (1351) takes it instead of refusing');
select pg_temp.as_user('rae');
select throws_ok($$select * from private.moderation_appeal_reviews$$, '42501', null, 'and they cannot reach the review record');
select pg_temp.as_op('olga');
select is(app.console_listing_detail(pg_temp.id('opp_a')) #>> '{appeals,0,re_review_notes}',
  'Read the appeal, read the listing and the application form as they stand, and applied with a test account. Reporter: Rae Stranger.', 'the operator reads it back');
select is(app.console_listing_detail(pg_temp.id('opp_a')) #>> '{appeals,0,notice_state}', 'Queued', 'and sees the email has not left yet');

-- The email leaves, or it does not --------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select app.finish_platform_email(e.id, true, 'provider-1', null) from private.platform_emails e
  where e.template = 'moderation_notice' and e.to_email = 'rae@reporter.test' and e.args ->> 'kind' = 'moderation_appeal.decided';
select private.sync_legal_queue_feeds();
select ok((select told_at is not null from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_same')), 'once the provider takes the email, the record says they were told');
select is((select count(*)::int from app.legal_queue_items where rule_code = 'undelivered_notice'), 0, 'and nothing opens in the queue');

-- The outcome of the report itself went to Rae too. It fails on all five attempts, as when an address is not on the allowlist.
insert into world select 'report_email', e.id from private.platform_emails e where e.template = 'moderation_notice' and e.to_email = 'rae@reporter.test' and e.args ->> 'kind' = 'listing_report.decided';
update private.platform_emails set attempts = 5, send_state = 'Sending' where id = pg_temp.id('report_email');
select is(app.finish_platform_email(pg_temp.id('report_email'), false, null, 'Recipient not on the allowlist.'), 'Failed', 'an email fails for good on its fifth attempt');
select private.sync_legal_queue_feeds();
insert into world select 'undelivered_item', id from app.legal_queue_items where source_id = pg_temp.id('report_email');
select is((select rule_code from app.legal_queue_items where id = pg_temp.id('undelivered_item')), 'undelivered_notice', 'and opens an item with its own clock');
select is((select due_at from app.legal_queue_items where id = pg_temp.id('undelivered_item')),
  private.legal_clock_end((select received_at from app.legal_queue_items where id = pg_temp.id('undelivered_item')), 2, 'Business Days'), 'two business days to tell them another way');
select is((select requester_contact from app.legal_queue_items where id = pg_temp.id('undelivered_item')), null, 'the item keeps no copy of the address');
select ok(private.sweep_legal_queue() >= 1, 'the next sweep alerts on it, whatever the time of day');
select pg_temp.as_op('olga');
select is(app.console_legal_queue_item(pg_temp.id('undelivered_item')) ->> 'requester_contact', 'rae@reporter.test', 'the operator reads who it was for live from the outbox');
select is(app.console_legal_queue_item(pg_temp.id('undelivered_item')) ->> 'details', 'We found no violation.', 'and what it said');
select is(app.console_legal_queue() #>> '{delivery,notices_failed}', '1', 'the queue page warns about it');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Phoned them and read out the result.')$$, pg_temp.id('undelivered_item')),
  'an operator closes it, because nothing else can');
select pg_temp.as_platform();
select is(api_public.legal_queue_heartbeat() ->> 'email_ok', 'false', 'a failed email also fails the outside heartbeat for two days');

-- A member the queue reaches --------------------------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'removal', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it. You may appeal within six months.')$$, pg_temp.id('opp_b')), 'a removal');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'appeal_member', app.file_moderation_appeal(%L, 'It is a statutory card check.')$$, pg_temp.id('removal')), 'the author appeals');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Reversed', 'A statutory card check breaks no rule.', 'Read the statute the appeal cites.')$$, pg_temp.id('appeal_member')),
  'the same person reverses their own decision');
select pg_temp.as_platform();
select is((select told_by from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_member')), 'Notification', 'a member is told through the queue');
select ok((select told_at is not null from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_member')), 'at once');
select is((select message_args ->> 'reviewer' from app.notifications where recipient_person_id = pg_temp.id('carol') and kind = 'moderation_appeal.decided' and subject_id = pg_temp.id('opp_b')), 'same',
  'and told who re-reviewed it');
select ok(not private.opportunity_removed(pg_temp.id('opp_b')), 'the reversal takes effect');

-- A named outside reviewer, if one is ever appointed ---------------------------------------------------------------------------
select pg_temp.as_op('olga');
select is(app.console_listing_detail(pg_temp.id('opp_c')) -> 'outside_reviewer', 'null'::jsonb, 'none is appointed, and nothing says one is');
select lives_ok($$insert into world select 'outside', app.console_appoint_outside_reviewer('Noor Adeyemi', 'Adeyemi Review', 'Noor@Adeyemi.test', 'Independent appeals from now on.')$$,
  'an Administrator appoints a named outside reviewer');
select throws_ok($$select app.console_appoint_outside_reviewer('Second', null, 'second@adeyemi.test', 'Another.')$$, 'XR001',
  'outside_reviewer_exists: An outside reviewer is already appointed. End that appointment first.', 'one at a time');
select lives_ok(format($$insert into world select 'removal_c', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it. You may appeal within six months.')$$, pg_temp.id('opp_c')), 'a removal');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'appeal_outside', app.file_moderation_appeal(%L, 'Wrong.')$$, pg_temp.id('removal_c')), 'an appeal');
select pg_temp.as_platform();
select private.sweep_legal_queue();
select ok((select args ->> 'audience' = 'reviewer' from private.platform_emails where template = 'legal_clock_alert' and to_email = 'noor@adeyemi.test' limit 1),
  'the alert reaches the outside reviewer');
select pg_temp.as_op('olga');
select throws_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'Stands.', 'I read it.')$$, pg_temp.id('appeal_outside')), 'XR001',
  'moderation_appeal_outside_reviewer: This appeal goes to the outside reviewer. Record their decision once they have made it.',
  'the operator may no longer decide it alone');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'The fee breaks the rule.', 'Noor Adeyemi read the file and wrote the attached.', p_outside_reviewer_decided => true)$$, pg_temp.id('appeal_outside')),
  'and records what the reviewer decided');
select pg_temp.as_platform();
select ok((select not same_reviewer and outside_reviewer_id = pg_temp.id('outside') from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_outside')),
  'the record names the reviewer');
select ok((select message_args ->> 'reviewer' = 'outside' and message_args ->> 'reviewerName' = 'Noor Adeyemi' from app.notifications
  where recipient_person_id = pg_temp.id('carol') and kind = 'moderation_appeal.decided' and subject_id = pg_temp.id('opp_c')), 'and so does the notice to the person');

-- Ending the appointment gives appeals back ----------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'removal_d', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it. You may appeal within six months.')$$, pg_temp.id('opp_d')), 'another removal');
select lives_ok($$insert into world select 'hand_appeal', app.console_add_legal_queue_item('abuse_appeal', 'Account suspension appeal', (now() at time zone 'America/New_York')::timestamp)$$,
  'an appeal that arrived by email, while the reviewer is appointed');
select throws_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Upheld.', false, 'Read it again.', 'Emailed them.')$$, pg_temp.id('hand_appeal')), 'XR001',
  'moderation_appeal_outside_reviewer: This appeal goes to the outside reviewer. Record their decision once they have made it.', 'is theirs too');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Upheld by the reviewer.', false, 'Noor Adeyemi read the file.', 'Emailed them and named the reviewer.', false, true)$$, pg_temp.id('hand_appeal')),
  'and the operator records what they decided');
select pg_temp.as_platform();
select ok((select outside_reviewer_id = pg_temp.id('outside') and not re_review_same_person from app.legal_queue_items where id = pg_temp.id('hand_appeal')), 'the record names them');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'appeal_after', app.file_moderation_appeal(%L, 'Wrong again.')$$, pg_temp.id('removal_d')), 'an appeal filed before the appointment ends');
select pg_temp.as_op('olga');
select throws_ok(format($$select app.console_end_outside_reviewer(%L, ' ')$$, pg_temp.id('outside')), 'XR001',
  'outside_reviewer_reason: Say why, in up to 500 characters.', 'ending an appointment needs a reason');
select lives_ok(format($$select app.console_end_outside_reviewer(%L, 'The agreement ended.')$$, pg_temp.id('outside')), 'an Administrator ends the appointment');
select throws_ok(format($$select app.console_end_outside_reviewer(%L, 'Again.')$$, pg_temp.id('outside')), 'XR001',
  'outside_reviewer_missing: That appointment has already ended. Reload the page.', 'once');
select is(app.console_listing_detail(pg_temp.id('opp_d')) -> 'outside_reviewer', 'null'::jsonb, 'nothing says one is appointed any more');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'The fee breaks the rule.', 'Read the file afresh.')$$, pg_temp.id('appeal_after')),
  'and the appeal returns to an operator''s re-review, with no reviewer to record');
select pg_temp.as_platform();
select ok((select outside_reviewer_id is null and same_reviewer from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_after')), 'and the record says the first decider did it');
select ok(not exists (select 1 from private.platform_emails e where e.to_email = 'noor@adeyemi.test' and e.created_at > (select ended_at from private.legal_outside_reviewers where id = pg_temp.id('outside'))),
  'the former reviewer gets no more alerts');

-- A member with every channel off is still told ----------------------------------------------------------------------------------
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'removal_e', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it. You may appeal within six months.')$$, pg_temp.id('opp_e')), 'a removal');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'appeal_silent', app.file_moderation_appeal(%L, 'Wrong.')$$, pg_temp.id('removal_e')), 'an appeal by a member');
select pg_temp.as_platform();
insert into app.notification_preferences (membership_id, category_code, channel, enabled)
select m.id, 'account', c.channel::app.notification_channel, false
from app.memberships m cross join (values ('In App'), ('Email'), ('SMS'), ('Push')) as c (channel)
where m.person_id = pg_temp.id('carol') and m.org_id = pg_temp.id('org_a');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'It stands.', 'Read it again.')$$, pg_temp.id('appeal_silent')), 'decided, after they turned every channel of the category off');
select pg_temp.as_platform();
select is((select told_by from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_silent')), 'Email', 'an archived notification with no delivery reaches nobody, so the result goes by email');
select is((select count(*)::int from private.platform_emails where template = 'moderation_notice' and to_email = lower((select u.email from auth.users u join app.people p on p.user_id = u.id where p.id = pg_temp.id('carol')))
  and args -> 'values' ->> 'statement' = 'It stands.'), 1, 'one email with the result');

-- Someone with no email left --------------------------------------------------------------------------------------------------
select pg_temp.as_user('rae');
insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_f'), 'Fraud', 'Asks for a fee.');
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'no_action_f', app.console_decide_listing(%L, 'No Action', 'No Violation', 'Terms 7.6', 'No fee.', 'We found no violation.')$$, pg_temp.id('opp_f')), 'a decision on their report');
select pg_temp.as_user('rae');
select lives_ok(format($$insert into world select 'appeal_gone', app.file_moderation_appeal(%L, 'They do.')$$, pg_temp.id('no_action_f')), 'and their appeal');
select pg_temp.as_platform();
update auth.users set email = null where id = pg_temp.id('rae_user');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Upheld', 'It stands.', 'Read it again.')$$, pg_temp.id('appeal_gone')), 'decided after their email is gone');
select pg_temp.as_platform();
select is((select told_by from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_gone')), null, 'the record says no channel could reach them');
select private.sync_legal_queue_feeds();
select is((select rule_code from app.legal_queue_items where source_table = 'private.moderation_appeal_reviews' and source_id = pg_temp.id('appeal_gone')), 'undelivered_notice', 'and that opens an item too');
insert into world select 'gone_item', id from app.legal_queue_items where source_id = pg_temp.id('appeal_gone');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_transition_legal_queue_item(%L, 'Received', 'Completed', 'Reached them by the phone number on their report.')$$, pg_temp.id('gone_item')), 'an operator tells them another way');
select pg_temp.as_platform();
select ok((select told_by = 'Operator' and told_at is not null from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_gone')), 'and the appeal''s record now says they were told');

-- A statement of reasons reaches the affected party whatever their settings -------------------------------------------------------
-- Everyone who manages the marketplace in org A and the author have every channel of the category off.
select pg_temp.public_listing('opp_g', 'Summer Series Stagehands');
select pg_temp.public_listing('opp_h', 'Summer Series Porters');
select pg_temp.public_listing('opp_i', 'Summer Series Grips');
select pg_temp.as_platform();
insert into app.notification_preferences (membership_id, category_code, channel, enabled)
select m.id, 'account', c.channel::app.notification_channel, false
from app.memberships m cross join (values ('In App'), ('Email'), ('SMS'), ('Push')) as c (channel)
where m.org_id = pg_temp.id('org_a') and m.person_id <> pg_temp.id('carol')
on conflict do nothing;
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'removal_g', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it. You may appeal within six months.')$$, pg_temp.id('opp_g')), 'a removal, with every channel off');
select pg_temp.as_platform();
select cmp_ok((select count(*)::int from private.platform_emails where template = 'moderation_notice' and args ->> 'kind' = 'listing.moderated'
  and args -> 'values' ->> 'title' = 'Summer Series Stagehands' and args -> 'values' ->> 'statement' = 'We removed it. You may appeal within six months.'), '>=', 1,
  'the statement of reasons goes by email, because the queue reaches nobody');
select is((select org_id from private.platform_emails where template = 'moderation_notice' and args -> 'values' ->> 'title' = 'Summer Series Stagehands' limit 1), pg_temp.id('org_a'),
  'and carries its org, so the org purge takes it');
select is((select count(*)::int from app.legal_queue_items where source_table = 'listing.moderated' and source_id = pg_temp.id('removal_g')), 0, 'so nothing needs opening');
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'no_action_g', app.console_decide_listing(%L, 'No Action', 'No Violation', 'Terms 7.6', 'No fee.', 'We found no violation.')$$, pg_temp.id('opp_h')),
  'a decision to take no action');
select pg_temp.as_platform();
select is((select count(*)::int from private.platform_emails where template = 'moderation_notice' and args -> 'values' ->> 'title' = 'Summer Series Porters'), 0,
  'is promised to no one, so it honours their settings');

-- Nobody left in the org to tell.
alter table app.memberships disable trigger user;
update app.memberships set valid_from = now() - interval '2 minutes', valid_to = now() - interval '1 minute' where org_id = pg_temp.id('org_a');
alter table app.memberships enable trigger user;
select pg_temp.as_op('olga');
select lives_ok(format($$insert into world select 'removal_i', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it, and nobody is left to read this.')$$, pg_temp.id('opp_i')), 'a removal when no member is left');
select pg_temp.as_platform();
insert into world select 'unreached', id from app.legal_queue_items where source_table = 'listing.moderated' and source_id = pg_temp.id('removal_i');
select is((select rule_code from app.legal_queue_items where id = pg_temp.id('unreached')), 'undelivered_notice', 'opens an item, so it does not vanish in silence');
select is((select tenant_org_id from app.legal_queue_items where id = pg_temp.id('unreached')), pg_temp.id('org_a'), 'naming the org');
select is((select details from app.legal_queue_items where id = pg_temp.id('unreached')), null, 'and keeping no copy of the words');
select pg_temp.as_op('olga');
select is(app.console_legal_queue_item(pg_temp.id('unreached')) ->> 'details', 'We removed it, and nobody is left to read this.', 'the operator reads them live');
select is(app.console_legal_queue_item(pg_temp.id('unreached')) ->> 'opportunity_id', pg_temp.id('opp_i')::text, 'and can open the listing');
select pg_temp.as_platform();

-- A reporter with no email left, on a report rather than an appeal.
insert into app.listing_reports (opportunity_id, reporter_person_id, reason, details) values (pg_temp.id('opp_f'), pg_temp.id('rae'), 'Fraud', 'Still asks for a fee.');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_decide_listing(%L, 'No Action', 'No Violation', 'Terms 7.6', 'No fee.', 'Nothing found.')$$, pg_temp.id('opp_f')), 'a decision on a report by someone with no email left');
select pg_temp.as_platform();
select is((select rule_code from app.legal_queue_items where source_table = 'listing_report.decided'
    and source_id in (select id from app.listing_reports where opportunity_id = pg_temp.id('opp_f'))), 'undelivered_notice',
  'leaves a record that they were not told');
select is(private.sync_legal_queue_feeds() >= 0, true, 'and the feed for reports keeps its own item for the same record');

-- Deleting a sign-in takes that address's notices and alerts with it. --------------------------------------------------------------
select pg_temp.new_user('tess', 'tess@reporter.test', 'Tess Leaving');
select pg_temp.as_platform();
insert into private.platform_emails (id, template, to_email, locale, args, send_state, sent_at, org_id)
values (private.uuid_v7(), 'moderation_notice', 'tess@reporter.test', 'en-US', '{"values": {"statement": "Words."}}', 'Failed', null, pg_temp.id('org_a')),
       (private.uuid_v7(), 'moderation_notice', 'tess@reporter.test', 'en-US', null, 'Sent', now() - interval '1 day', pg_temp.id('org_a')),
       (private.uuid_v7(), 'legal_clock_alert', 'tess@reporter.test', 'en-US', null, 'Sent', now() - interval '1 day', null),
       (private.uuid_v7(), 'party_invitation', 'tess@reporter.test', 'en-US', null, 'Sent', now() - interval '1 day', null);
-- A notice sent to the address Tess had before she changed it, which only its sign-in ties to her now.
insert into private.platform_emails (id, template, to_email, locale, args, send_state, sent_at, org_id, to_user_id)
values (private.uuid_v7(), 'moderation_notice', 'tess.old@reporter.test', 'en-US', null, 'Sent', now() - interval '2 days', pg_temp.id('org_a'),
        pg_temp.id('tess_user'));
insert into world select 'tess_email', id from private.platform_emails where to_email = 'tess@reporter.test' and send_state = 'Failed';
select private.sync_legal_queue_feeds();
insert into world select 'tess_item', id from app.legal_queue_items where source_table = 'private.platform_emails' and source_id = pg_temp.id('tess_email');
select is((select item_state::text from app.legal_queue_items where id = pg_temp.id('tess_item')), 'Received', 'a failed notice has an open item');
delete from auth.users where id = pg_temp.id('tess_user');
select is((select array_agg(template) from private.platform_emails where to_email = 'tess@reporter.test'), array['party_invitation'],
  'deleting the sign-in deletes its notices and alerts from the outbox, and leaves other templates to their own rules');
select is((select count(*)::int from private.platform_emails where to_email = 'tess.old@reporter.test'), 0,
  'and the notice sent to the address she had before, by its sign-in');
select private.sync_legal_queue_feeds();
select is((select item_state::text from app.legal_queue_items where id = pg_temp.id('tess_item')), 'Withdrawn', 'and the item closes, with nobody left to tell');

select * from finish();
rollback;
