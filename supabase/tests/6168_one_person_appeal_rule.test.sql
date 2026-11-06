-- pgTAP: migration 6168, the appeal rule made true for one person (RRR-248, ADR 0167). With one operator every appeal is
-- still decided: by a fresh, documented re-review, recorded with the reasons, and the person is told the result and that the
-- first decider did it. A named outside reviewer, once appointed, takes every appeal. A person the notification queue
-- cannot reach is told by email.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(36);

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
select is((select told_by from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_same')), 'Email', 'the record says how the person was told');
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

-- A member the queue reaches --------------------------------------------------------------------------------------------------
select lives_ok(format($$insert into world select 'removal', app.console_decide_listing(%L, 'Removed', 'Terms Violation', 'Acceptable Use Policy 3.2',
  'Asks for a fee.', 'We removed it. You may appeal within six months.')$$, pg_temp.id('opp_b')), 'a removal');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world select 'appeal_member', app.file_moderation_appeal(%L, 'It is a statutory card check.')$$, pg_temp.id('removal')), 'the author appeals');
select pg_temp.as_op('olga');
select lives_ok(format($$select app.console_decide_appeal(%L, 'Reversed', 'A statutory card check breaks no rule.', 'Read the statute the appeal cites.')$$, pg_temp.id('appeal_member')),
  'the same person reverses their own decision');
select pg_temp.as_platform();
select is((select told_by from private.moderation_appeal_reviews where moderation_appeal_id = pg_temp.id('appeal_member')), 'Notification', 'a member is told through the queue');
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

select * from finish();
rollback;
